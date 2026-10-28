import { describe, expect, it } from "vitest";
import { classifyIntent, type GenerateRequest, type GenerateResult, type LLMProvider } from "../src";

const result = (text: string, stopReason: GenerateResult["stopReason"]): GenerateResult => ({
  text,
  toolCalls: [],
  stopReason,
  usage: { inputTokens: 10, outputTokens: 5 },
  model: "m",
  provider: "p",
});

function scripted(...answers: GenerateResult[]) {
  const calls: GenerateRequest[] = [];
  const llm: LLMProvider = {
    name: "scripted",
    async generate(request) {
      calls.push(request);
      const next = answers.shift();
      if (!next) throw new Error("sem resposta roteirizada");
      return next;
    },
  };
  return { llm, calls };
}

const input = { history: [{ role: "customer" as const, text: "queria saber dos produtos" }], nonce: "n", organizationId: "o", conversationId: "c" };

describe("roteador: resposta cortada por limite de tokens", () => {
  it("o limite padrão deixa folga para modelos que raciocinam (não é mais 60)", async () => {
    const { llm, calls } = scripted(result('{"intent":"question","confidence":0.9}', "end"));
    await classifyIntent({ llm, ...input });
    expect(calls[0]?.maxOutputTokens).toBeGreaterThanOrEqual(400);
  });

  it("cortou antes do JSON (max_tokens, texto vazio): tenta de novo com mais folga e usa a resposta", async () => {
    const { llm, calls } = scripted(result("", "max_tokens"), result('{"intent":"buy","confidence":0.8}', "end"));
    const d = await classifyIntent({ llm, ...input });
    expect(calls).toHaveLength(2);
    expect((calls[1]?.maxOutputTokens ?? 0) > (calls[0]?.maxOutputTokens ?? 0)).toBe(true);
    expect(d).toMatchObject({ intent: "buy", confidence: 0.8 });
  });

  it("texto sem JSON mas que terminou normal: não repete (confiança 0 como antes)", async () => {
    const { llm, calls } = scripted(result("não sei", "end"));
    const d = await classifyIntent({ llm, ...input });
    expect(calls).toHaveLength(1);
    expect(d.confidence).toBe(0);
  });
});
