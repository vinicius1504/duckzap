export * from "./llm";
export * from "./registry";
export { createFakeLlm } from "./providers/fake";
// Os adaptadores reais se registram ao serem importados AQUI; o código do produto usa apenas `createLlm(env)`.
export { createAnthropicLlm, buildAnthropicBody, fromAnthropicResponse, mapAnthropicError, toAnthropicMessages } from "./providers/anthropic";
export type { AnthropicLike, AnthropicResponse } from "./providers/anthropic";
export { createOpenAiLlm, toOpenAiMessages, fromOpenAiResponse } from "./providers/openai";
export { createGeminiLlm, toGeminiContents, fromGeminiResponse } from "./providers/gemini";
export * from "./agents";
