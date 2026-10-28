import { describe, expect, it } from "vitest";
import { makeInviteToken, parseInviteToken } from "./invite-token";

const SECRET = "s".repeat(32);
const ID = "0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("token de aceite do convite", () => {
  it("ida e volta devolve o id do convite", () => {
    expect(parseInviteToken(SECRET, makeInviteToken(SECRET, ID))).toBe(ID);
  });

  it("o id puro (o que a tela de Equipe mostra) NÃO aceita o convite", () => {
    expect(parseInviteToken(SECRET, ID)).toBeNull();
  });

  it("assinatura adulterada, de outro convite ou de outro segredo é recusada", () => {
    const token = makeInviteToken(SECRET, ID);
    expect(parseInviteToken(SECRET, `${token}x`)).toBeNull();
    expect(parseInviteToken(SECRET, `${ID.replace("4a5b", "4a5c")}.${token.split(".")[1]}`)).toBeNull();
    expect(parseInviteToken("outro".repeat(10), token)).toBeNull();
    expect(parseInviteToken(SECRET, `${ID}.`)).toBeNull();
    expect(parseInviteToken(SECRET, `.${token.split(".")[1]}`)).toBeNull();
    expect(parseInviteToken(SECRET, "x".repeat(500))).toBeNull();
  });

  it("é determinístico: reenviar o convite devolve o mesmo link", () => {
    expect(makeInviteToken(SECRET, ID)).toBe(makeInviteToken(SECRET, ID));
  });
});
