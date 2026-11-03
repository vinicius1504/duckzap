import { describe, expect, it } from "vitest";
import { runScenario, type Scenario } from "../evals/harness";
import { buildDataBlock, CONTEXT_MESSAGES, isMediaPlaceholder, isShortFollowUp } from "../src";

/** Contexto: a IA lê as últimas CONTEXT_MESSAGES mensagens e usa a conversa (não só a mensagem nova) para decidir se sabe responder. */

const base: Scenario = {
  id: "ctx",
  description: "ctx",
  history: [{ role: "customer", text: "Vocês atendem Unimed?" }],
  router: { intent: "question", confidence: 0.9 },
  model: ["Atendemos sim: Unimed e Odontoprev."],
  expect: {},
};

const conversation = (...turns: [role: "customer" | "agent" | "human", text: string][]) => turns.map(([role, text]) => ({ role, text }));

describe("janela de contexto", () => {
  it("são 25 mensagens", () => {
    expect(CONTEXT_MESSAGES).toBe(25);
  });

  it("o bloco de dados leva as 25 últimas mensagens, da mais antiga à mais nova", () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? ("customer" as const) : ("agent" as const), text: `mensagem ${i + 1}` }));
    const block = buildDataBlock({ nonce: "n1", history });
    const lines = block.split("\n").filter((l) => /^\[(cliente|atendente|agente|equipe)[^\]]*\]:/.test(l) || /^\[[^\]]+\]: mensagem \d+$/.test(l));
    expect(lines).toHaveLength(25);
    expect(lines[0]).toContain("mensagem 16");
    expect(lines.at(-1)).toContain("mensagem 40");
  });

  it("o roteador também enxerga as 25 (não só as 6 últimas)", async () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 === 0 ? ("customer" as const) : ("agent" as const), text: `texto ${i + 1}` }));
    history.push({ role: "customer", text: "Vocês atendem Unimed?" });
    const { requests } = await runScenario({ ...base, history });
    const router = requests.find((r) => r.meta?.purpose === "agent_router");
    expect(router).toBeDefined();
    const content = String(router!.messages[0]!.content);
    expect(content.match(/^\[[^\]]+\]: /gm)).toHaveLength(25);
  });
});

describe("continuação da conversa: resposta curta não vira 'fora do conhecimento'", () => {
  const followUp = conversation(
    ["customer", "Vocês atendem Unimed?"],
    ["agent", "Atendemos sim: Unimed e Odontoprev."],
    ["customer", "e a Amil?"],
  );

  it("'e a Amil?' depois de uma conversa sobre convênios: o contexto sustenta e a IA responde", async () => {
    const { result } = await runScenario({ ...base, history: followUp, model: ["Sobre a Amil eu não tenho certeza, posso confirmar com a equipe?"] });
    expect(result.handoff).toBeNull();
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("controle: a mesma mensagem solta, sem conversa antes, continua indo para a equipe", async () => {
    const { result } = await runScenario({ ...base, history: conversation(["customer", "e a Amil?"]), model: undefined });
    expect(result.handoff?.kind).toBe("unknown_knowledge");
  });

  it("resposta curta sem nenhuma palavra do conhecimento ('sim', 'o preto') segue a conversa em andamento", async () => {
    for (const short of ["o preto", "pode ser", "quanto sai?"]) {
      const { result } = await runScenario({
        ...base,
        history: conversation(["customer", "Quero marcar uma limpeza"], ["agent", "Claro! Prefere de manhã ou à tarde?"], ["customer", short]),
        model: ["Perfeito, vou verificar para você."],
      });
      expect(result.handoff, short).toBeNull();
    }
  });

  it("mensagem LONGA e fora do assunto, mesmo no meio da conversa, ainda vai para a equipe", async () => {
    const { result } = await runScenario({
      ...base,
      history: conversation(["customer", "Vocês atendem Unimed?"], ["agent", "Atendemos sim: Unimed e Odontoprev."], ["customer", "Qual o prazo de entrega do pedido número 4521 da loja virtual de vocês?"]),
      model: undefined,
    });
    expect(result.handoff?.kind).toBe("unknown_knowledge");
  });

  it("roteador em dúvida: com conversa anterior segue como pergunta; sem conversa continua indo para a equipe", async () => {
    const withContext = await runScenario({ ...base, history: followUp, router: { intent: "question", confidence: 0.2 } });
    expect(withContext.result.handoff).toBeNull();
    const alone = await runScenario({ ...base, history: conversation(["customer", "qual o prazo de entrega do pedido 4521?"]), router: { intent: "question", confidence: 0.2 }, model: undefined });
    expect(alone.result.handoff?.kind).toBe("low_confidence");
  });
});

describe("imagem, áudio e documento sem texto", () => {
  it.each(["[o cliente enviou uma imagem]", "[o cliente enviou um áudio]", "[o cliente enviou um documento]"])("%s: não transfere por 'fora do conhecimento' nem gasta o roteador", async (placeholder) => {
    const { result, requests } = await runScenario({
      ...base,
      history: conversation(["customer", placeholder]),
      model: ["Recebi, mas não consigo abrir esse tipo de arquivo por aqui. Pode me contar por escrito o que você precisa?"],
    });
    expect(result.handoff).toBeNull();
    expect(result.messages.length).toBe(1);
    expect(requests.some((r) => r.meta?.purpose === "agent_router")).toBe(false);
  });

  it("três imagens seguidas (rajada só de arquivos) também não viram transferência", async () => {
    const { result } = await runScenario({
      ...base,
      history: conversation(["customer", "[o cliente enviou uma imagem]"], ["customer", "[o cliente enviou uma imagem]"], ["customer", "[o cliente enviou uma imagem]"]),
      model: ["Recebi suas imagens, mas não consigo abri-las por aqui. O que você precisa?"],
    });
    expect(result.handoff).toBeNull();
  });

  it("imagem com legenda de texto segue o fluxo normal (a legenda é a pergunta)", async () => {
    const { result } = await runScenario({ ...base, history: conversation(["customer", "Vocês atendem Unimed? (foto da carteirinha)"]) });
    expect(result.handoff).toBeNull();
  });

  it("os avisos de mídia são os mesmos que a API escreve", () => {
    for (const text of ["[o cliente enviou uma imagem]", "[o cliente enviou um áudio]", "[o cliente enviou um documento]"]) expect(isMediaPlaceholder(text)).toBe(true);
    expect(isMediaPlaceholder("oi, enviei uma imagem")).toBe(false);
    expect(isMediaPlaceholder("")).toBe(false);
  });
});

describe("resposta curta", () => {
  it("curta = até 40 caracteres e 6 palavras", () => {
    for (const t of ["sim", "o preto", "quanto sai?", "pode ser amanhã às 14h"]) expect(isShortFollowUp(t), t).toBe(true);
    expect(isShortFollowUp("Qual o prazo de entrega do pedido número 4521 da loja virtual?")).toBe(false);
    expect(isShortFollowUp("")).toBe(false);
  });
});
