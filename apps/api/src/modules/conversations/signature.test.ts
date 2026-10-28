import { describe, expect, it } from "vitest";
import { signMessage, signatureLabel } from "./signature";

describe("assinatura das mensagens de pessoa", () => {
  it("primeiro nome e equipe, em negrito do WhatsApp, e o texto na linha de baixo", () => {
    expect(signMessage("Olá, tudo bem?", "Rafael Costa", "Vendas")).toBe("*Rafael (Vendas):*\nOlá, tudo bem?");
  });
  it("sem equipe, só o nome", () => {
    expect(signMessage("Oi", "Marina Alves", null)).toBe("*Marina:*\nOi");
  });
  it("não altera o texto digitado (inclusive quebras de linha)", () => {
    expect(signMessage("linha 1\n\nlinha 2", "Ana", "Suporte")).toBe("*Ana (Suporte):*\nlinha 1\n\nlinha 2");
  });
  it("tira caracteres de formatação do nome e da equipe, para não quebrar o negrito", () => {
    expect(signatureLabel("*Ra_fa~el*", "Ven*das_")).toBe("Ra (Ven das)");
    expect(signatureLabel("João\nSilva", null)).toBe("João");
  });
  it("limita o nome da equipe", () => {
    expect(signatureLabel("Ana", "Atendimento ao cliente e pós-venda da região sul")?.length).toBeLessThanOrEqual("Ana ()".length + 30);
  });
  it("sem nome utilizável ou sem texto, devolve o original", () => {
    expect(signMessage("Oi", "   ", "Vendas")).toBe("Oi");
    expect(signMessage("Oi", "***", null)).toBe("Oi");
    expect(signMessage("   ", "Ana", "Vendas")).toBe("   ");
    expect(signMessage("", "Ana", null)).toBe("");
  });
});
