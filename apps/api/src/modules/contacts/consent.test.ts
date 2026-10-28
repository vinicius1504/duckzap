import { describe, expect, it } from "vitest";
import { effectiveConsentStatus, interpretConsentReply, isExplicitOptOut, nextConsentStatus } from "./consent";

describe("interpretConsentReply (palavras-chave primeiro, na dúvida NÃO aceita)", () => {
  it.each(["SIM", "sim", "Sim!", "aceito", "Aceito sim", "pode", "pode sim", "Pode mandar", "claro", "ok", "S", "sim, pode enviar", "👍"])(
    "%s → granted",
    (text) => expect(interpretConsentReply(text)).toBe("granted"),
  );

  it.each([
    "NÃO",
    "não",
    "Nao",
    "n",
    "N",
    "sair",
    "SAIR",
    "parar",
    "pare",
    "cancelar",
    "não quero",
    "nao aceito",
    "PARA",
    "stop",
    "pode parar",
    "sim mas não quero",
    "remover meu número",
  ])("%s → denied", (text) => expect(interpretConsentReply(text)).toBe("denied"));

  it.each(["", "   ", "talvez", "quem é você?", "pode me ligar amanhã?", "sim, e qual o preço do clareamento?", "bom dia", "🤔"])(
    "%j → ambiguous (não conta como aceito)",
    (text) => expect(interpretConsentReply(text)).toBe("ambiguous"),
  );

  it("recusa vence quando a mensagem mistura sim e não", () => {
    expect(interpretConsentReply("sim, mas não me mande mais nada")).toBe("denied");
  });

  it("não confunde 'para' no meio da frase com saída", () => {
    expect(interpretConsentReply("pode enviar para mim")).not.toBe("denied");
  });
});

describe("isExplicitOptOut (conversas comuns)", () => {
  it("SAIR/PARAR curtos bloqueiam", () => {
    for (const t of ["SAIR", "parar", "Quero sair", "cancelar mensagens", "stop"]) expect(isExplicitOptOut(t)).toBe(true);
  });
  it("conversa normal e textos longos não bloqueiam", () => {
    expect(isExplicitOptOut("não, obrigado, vou pensar")).toBe(false);
    expect(isExplicitOptOut("Preciso cancelar minha consulta de quinta e também queria saber sobre o orçamento")).toBe(false);
  });
});

describe("nextConsentStatus", () => {
  it("granted só nasce de resposta afirmativa clara", () => {
    expect(nextConsentStatus("pending", "granted")).toBe("granted");
    expect(nextConsentStatus("pending", "ambiguous")).toBe("pending");
  });
  it("recusa vira denied, inclusive de quem já tinha aceitado", () => {
    expect(nextConsentStatus("pending", "denied")).toBe("denied");
    expect(nextConsentStatus("granted", "denied")).toBe("denied");
  });
  it("denied é permanente: nenhuma resposta o reverte", () => {
    expect(nextConsentStatus("denied", "granted")).toBe("denied");
    expect(nextConsentStatus("denied", "ambiguous")).toBe("denied");
  });
});

describe("effectiveConsentStatus (pending → expired em 7 dias)", () => {
  const sent = new Date("2025-06-01T12:00:00Z");
  const at = (days: number, extraMs = 0) => new Date(sent.getTime() + days * 86_400_000 + extraMs);
  it("pendente dentro do prazo continua pendente", () => {
    expect(effectiveConsentStatus({ status: "pending", inviteSentAt: sent }, at(6))).toBe("pending");
    expect(effectiveConsentStatus({ status: "pending", inviteSentAt: sent }, at(7))).toBe("pending");
  });
  it("pendente passado de 7 dias vale como expirada", () => {
    expect(effectiveConsentStatus({ status: "pending", inviteSentAt: sent }, at(7, 1))).toBe("expired");
  });
  it("convite ainda não enviado (na fila) não expira", () => {
    expect(effectiveConsentStatus({ status: "pending", inviteSentAt: null }, at(30))).toBe("pending");
  });
  it("granted e denied nunca expiram", () => {
    expect(effectiveConsentStatus({ status: "granted", inviteSentAt: sent }, at(90))).toBe("granted");
    expect(effectiveConsentStatus({ status: "denied", inviteSentAt: sent }, at(90))).toBe("denied");
  });
});
