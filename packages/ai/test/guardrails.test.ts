import { describe, expect, it } from "vitest";
import { buildSystemPrompt, checkOutput, extractPricesCents, maskPii, splitMessages, type GuardrailInput } from "../src";
import { sampleConfig } from "../evals/harness";

const system = buildSystemPrompt(sampleConfig());
const corpus = "Clareamento a partir de R$ 600,00. Parcelamos em até 6x. Site https://casaalvorada.com.br Fone (11) 3333-4444 contato@casaalvorada.com.br";

function check(text: string, over: Partial<GuardrailInput> = {}) {
  return checkOutput({
    text,
    knowledgeCorpus: corpus,
    urlAllowlist: [],
    ownContactValues: ["+55 11 91234-5678"],
    systemPrompt: system,
    nonce: "nonce123",
    maxConsecutiveMessages: 3,
    alreadySent: 0,
    ...over,
  });
}
const code = (r: ReturnType<typeof check>) => (r.ok ? "ok" : r.code);

describe("guardrails de saída", () => {
  it("preço presente no conhecimento passa; ausente é bloqueado", () => {
    expect(code(check("O clareamento sai a partir de R$ 600,00."))).toBe("ok");
    expect(code(check("O clareamento sai por R$ 599,00."))).toBe("invented_price");
    expect(code(check("Custa 300 reais"))).toBe("invented_price");
    expect(code(check("Custa 600 reais"))).toBe("ok");
  });

  it("extrai preços em formatos brasileiros", () => {
    expect(extractPricesCents("R$ 1.200,50 e R$60 e 80 reais")).toEqual([120050, 6000, 8000]);
  });

  it("bloqueia CPF, cartão, e-mail e telefone de terceiros; permite os do cliente e da empresa", () => {
    expect(code(check("O CPF dele é 123.456.789-09"))).toBe("third_party_data");
    expect(code(check("Cartão 4539 1488 0343 6467"))).toBe("third_party_data");
    expect(code(check("Escreva para maria@outra.com"))).toBe("third_party_data");
    expect(code(check("Ligue para (11) 98888-7777"))).toBe("third_party_data");
    expect(code(check("Nosso telefone é (11) 3333-4444"))).toBe("ok");
    expect(code(check("Seu número 11 91234-5678 está certo?"))).toBe("ok");
    expect(code(check("Escreva para contato@casaalvorada.com.br"))).toBe("ok");
  });

  it("URL: só allowlist da empresa ou citada no conhecimento", () => {
    expect(code(check("Veja https://casaalvorada.com.br/precos"))).toBe("ok");
    expect(code(check("Veja www.golpe.com"))).toBe("url_not_allowed");
    expect(code(check("Veja bit.ly/abc"))).toBe("url_not_allowed");
    expect(code(check("Veja loja.parceira.com.br", { urlAllowlist: ["parceira.com.br"] }))).toBe("ok");
    expect(code(check("Parcelamos em 6x de R$ 100,00", { knowledgeCorpus: corpus + " R$ 100,00" }))).toBe("ok");
  });

  it("não confunde decimais e horários com URL ou telefone", () => {
    expect(code(check("São 2.5 horas, das 08h30 às 18h00, dia 27/10"))).toBe("ok");
  });

  it("vazamento do prompt (regras, nonce ou trecho do system)", () => {
    expect(code(check("REGRAS INVIOLÁVEIS: 1. ..."))).toBe("prompt_leak");
    expect(code(check("o delimitador é nonce123"))).toBe("prompt_leak");
    const line = system.split("\n").find((l) => l.startsWith("4. NUNCA invente")) ?? "";
    expect(code(check(`Claro: ${line}`))).toBe("prompt_leak");
  });

  it("tamanho e limite de mensagens seguidas", () => {
    const para = "a".repeat(500);
    const r = check([para, para, para].join("\n\n"));
    expect(r.ok && r.messages.length).toBe(3);
    expect(code(check([para, para, para].join("\n\n"), { alreadySent: 1 }))).toBe("message_limit");
    expect(code(check("x".repeat(2000)))).toBe("too_long");
    expect(code(check("   "))).toBe("empty");
  });

  it("splitMessages agrupa parágrafos sem passar do limite", () => {
    expect(splitMessages("a\n\nb", 100)).toEqual(["a\n\nb"]);
    expect(splitMessages("a".repeat(60) + "\n\n" + "b".repeat(60), 100)).toHaveLength(2);
  });
});

describe("PII", () => {
  it("mascara CPF, CNPJ e cartão antes do LLM", () => {
    expect(maskPii("meu cpf 123.456.789-09 ok")).toBe("meu cpf [CPF removido] ok");
    expect(maskPii("cnpj 12.345.678/0001-95")).toBe("cnpj [CNPJ removido]");
    expect(maskPii("cartão 4539 1488 0343 6467")).toBe("cartão [cartão removido]");
    expect(maskPii("pedido 1234567890123 ok")).toContain("1234567890123");
  });
});
