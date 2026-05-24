/**
 * API Module
 *
 * Two sub-modules:
 *   llm/     — LLM provider gateway (OpenAI, Anthropic, Azure, Gemini, Ollama)
 *   logging/ — Analytics/logging backends (gateway + mapper)
 */

export {
    LlmGateway,
    LlmGatewayOptions,
    LLMMessage,
    LLMRequest,
    LLMResponse,
    LLMValidationError,
    LLMAPIError,
    createLlmGateway,
    LlmMapper,
    // Backward-compat aliases
    LLMController,
    LLMControllerOptions,
    createLLMController,
} from './llm';

export { RubyLogGateway, SessionLogGateway } from './logging';
export { LogMapper } from './logging';
export type { LogEvent, SessionSummary, LogPayload } from './logging';

export { TutorChatGateway } from './tutor/tutor-chat-gateway';
export type { TutorChatResult } from './tutor/tutor-chat-gateway';
