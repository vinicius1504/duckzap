import type { GenerateRequest, GenerateResult, LLMProvider } from "../llm";
import { registerProvider } from "../registry";

/**
 * Provedor de teste/dev sem chave: resposta fixa e previsível (ou a função informada).
 * É o padrão enquanto `LLM_PROVIDER` não estiver configurado; testes de agentes usam este.
 */
export function createFakeLlm(
  reply: (request: GenerateRequest) => Partial<GenerateResult> | string = () => "Resposta simulada.",
): LLMProvider {
  return {
    name: "fake",
    async generate(request) {
      const out = reply(request);
      const partial = typeof out === "string" ? { text: out } : out;
      return {
        text: "",
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: `fake-${request.tier}`,
        provider: "fake",
        ...partial,
      };
    },
  };
}

registerProvider("fake", () => createFakeLlm());
