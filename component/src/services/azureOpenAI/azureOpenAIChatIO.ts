import {OpenAIConverseResult, ResultChoice, ToolAPI, ToolCalls} from '../../types/openAIResult';
import {OpenAIConverseBodyInternal, SystemMessageInternal} from '../../types/openAIInternal';
import {FetchFunc, RequestUtils} from '../../utils/HTTP/requestUtils';
import {MessageUtils} from '../../views/chat/messages/messageUtils';
import {ChatFunctionHandler, AzureOpenAIChat, AzureConfig} from '../../types/azureOpenAI';
import {DirectConnection} from '../../types/directConnection';
import {MessageLimitUtils} from '../utils/messageLimitUtils';
import {MessageContentI} from '../../types/messagesInternal';
import {Messages} from '../../views/chat/messages/messages';
import {Response as ResponseI} from '../../types/response';
import {HTTPRequest} from '../../utils/HTTP/HTTPRequest';
import {DirectServiceIO} from '../utils/directServiceIO';
import {AzureOpenAIUtils} from './utils/azureOpenAIUtils';
import {Stream} from '../../utils/HTTP/stream';
import {DeepChat} from '../../deepChat';

type ImageContent = {type: string; image_url?: {url?: string}; text?: string}[];

export class AzureOpenAIChatIO extends DirectServiceIO {
  override insertKeyPlaceholderText = 'OpenAI API Key';
  override keyHelpUrl = 'https://platform.openai.com/account/api-keys';
  url = ''; // set in constructor
  permittedErrorPrefixes = ['Incorrect'];
  private readonly _functionHandler?: ChatFunctionHandler;
  private _streamToolCalls?: ToolCalls;
  asyncCallInProgress = false; // used when streaming tools
  private readonly _systemMessage: SystemMessageInternal =
    AzureOpenAIChatIO.generateSystemMessage('You are a helpful assistant.');

  constructor(deepChat: DeepChat) {
    const directConnectionCopy = JSON.parse(JSON.stringify(deepChat.directConnection)) as DirectConnection;
    const apiKey = directConnectionCopy.azureOpenAI;

    if (!directConnectionCopy.azureOpenAI?.azureConfig) {
      throw Error("Azure OpenAI endpoint not defined")
    }

    const azureConfig: AzureConfig = directConnectionCopy.azureOpenAI?.azureConfig;

    super(deepChat, AzureOpenAIUtils.buildKeyVerificationDetails(azureConfig), AzureOpenAIUtils.buildHeaders, apiKey);

    // need to call super before accessing this
    this.url= `${azureConfig.endpoint}/openai/deployments/${azureConfig.deploymentId}/completions?api-version=${azureConfig.version}`;

    const config = directConnectionCopy.azureOpenAI?.chat; // can be undefined as this is the default service
    if (typeof config === 'object') {
      if (config.system_prompt) this._systemMessage = AzureOpenAIChatIO.generateSystemMessage(config.system_prompt);
      const {function_handler} = deepChat.directConnection?.azureOpenAI?.chat as AzureOpenAIChat;
      if (function_handler) this._functionHandler = function_handler;
      this.cleanConfig(config);
      Object.assign(this.rawBody, config);
    }
    this.maxMessages ??= -1;
    this.rawBody.model ??= 'gpt-4o';
  }

  private static generateSystemMessage(system_prompt: string): SystemMessageInternal {
    return {role: 'system', content: system_prompt};
  }

  private cleanConfig(config: AzureOpenAIChat) {
    delete config.system_prompt;
    delete config.function_handler;
  }

  private static getContent(message: MessageContentI) {
    if (message.files && message.files.length > 0) {
      const content: ImageContent = message.files.map((file) => {
        return {type: 'image_url', image_url: {url: file.src}};
      });
      if (message.text && message.text.trim().length > 0) content.unshift({type: 'text', text: message.text});
      return content;
    }
    return message.text;
  }

  // prettier-ignore
  private preprocessBody(body: OpenAIConverseBodyInternal, pMessages: MessageContentI[]) {
    const bodyCopy = JSON.parse(JSON.stringify(body));
    const processedMessages = MessageLimitUtils.getCharacterLimitMessages(pMessages,
        this.totalMessagesMaxCharLength ? this.totalMessagesMaxCharLength - this._systemMessage.content.length : -1)
      .map((message) => {
        return {content: AzureOpenAIChatIO.getContent(message),
          role: message.role === MessageUtils.USER_ROLE ? 'user' : 'assistant'};});
    if (pMessages.find((message) => message.files && message.files.length > 0)) {
      bodyCopy.max_tokens ??= 300; // otherwise AI does not return full responses - remove when this behaviour changes
    }
    bodyCopy.messages = [this._systemMessage, ...processedMessages];
    return bodyCopy;
  }

  override async callServiceAPI(messages: Messages, pMessages: MessageContentI[]) {
    if (!this.connectSettings) throw new Error('Request settings have not been set up');
    const body = this.preprocessBody(this.rawBody, pMessages);
    const stream = this.stream;
    if ((stream && (typeof stream !== 'object' || !stream.simulation)) || body.stream) {
      body.stream = true;
      Stream.request(this, body, messages);
    } else {
      HTTPRequest.request(this, body, messages);
    }
  }

  // prettier-ignore
  override async extractResultData(result: OpenAIConverseResult,
      fetchFunc?: FetchFunc, prevBody?: AzureOpenAIChat): Promise<ResponseI> {
    if (result.error) throw result.error.message;
    if (result.choices?.[0]?.delta) {
      return this.extractStreamResult(result.choices[0], fetchFunc, prevBody);
    }
    if (result.choices?.[0]?.message) {
      if (result.choices[0].message.tool_calls) {
        return this.handleTools(result.choices[0].message, fetchFunc, prevBody);
      }
      return {text: result.choices[0].message.content};
    }
    return {text: ''};
  }

  private async extractStreamResult(choice: ResultChoice, fetchFunc?: FetchFunc, prevBody?: AzureOpenAIChat) {
    const {delta, finish_reason} = choice;
    if (finish_reason === 'tool_calls') {
      this.asyncCallInProgress = true;
      const tools = {tool_calls: this._streamToolCalls};
      this._streamToolCalls = undefined;
      return this.handleTools(tools, fetchFunc, prevBody);
    } else if (delta?.tool_calls) {
      if (!this._streamToolCalls) {
        this._streamToolCalls = delta.tool_calls;
      } else {
        delta.tool_calls.forEach((tool, index) => {
          if (this._streamToolCalls) this._streamToolCalls[index].function.arguments += tool.function.arguments;
        });
      }
    }
    return {text: delta?.content || ''};
  }

  // prettier-ignore
  private async handleTools(tools: ToolAPI, fetchFunc?: FetchFunc, prevBody?: AzureOpenAIChat): Promise<ResponseI> {
    // tool_calls, requestFunc and prevBody should theoretically be defined
    if (!tools.tool_calls || !fetchFunc || !prevBody || !this._functionHandler) {
      throw Error(
        'Please define the `function_handler` property inside' +
          ' the [openAI](https://deepchat.dev/docs/directConnection/openAI#Chat) object.'
      );
    }
    const bodyCp = JSON.parse(JSON.stringify(prevBody));
    const functions = tools.tool_calls.map((call) => {
      return {name: call.function.name, arguments: call.function.arguments};
    });
    const handlerResponse = await this._functionHandler?.(functions);
    if (handlerResponse.text) {
      const response = {text: handlerResponse.text};
      return await this.deepChat.responseInterceptor?.(response) || response;
    }
    bodyCp.messages.push({tool_calls: tools.tool_calls, role: 'assistant', content: null});
    if ((Array.isArray(handlerResponse) && !handlerResponse.find((response) => typeof response !== 'string'))
        || functions.length === handlerResponse.length) {
      handlerResponse.forEach((resp, index) => {
        const toolCall = tools.tool_calls?.[index];
        bodyCp?.messages.push({
          role: 'tool',
          tool_call_id: toolCall?.id,
          name: toolCall?.function.name,
          content: resp.response,
        });
      });
      delete bodyCp.tools;
      delete bodyCp.tool_choice;
      delete bodyCp.stream;
      try {
        let result = await fetchFunc?.(bodyCp).then((resp) => RequestUtils.processResponseByType(resp));
        result = await this.deepChat.responseInterceptor?.(result) || result;
        if (result.error) throw result.error.message;
        return {text: result.choices[0].message.content || ''};
      } catch (e) {
        this.asyncCallInProgress = false;
        throw e;
      }
    }
    throw Error(
      'Response object must either be {response: string}[] for each individual function ' +
        'or {text: string} for a direct response, see https://deepchat.dev/docs/directConnection/OpenAI#FunctionHandler.'
    );
  }
}
