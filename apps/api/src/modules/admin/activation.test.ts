import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { activationCodeFor, activationRequired, verifyActivationCode } from "./activation";

const KEY = randomBytes(32);
const ID = "0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("código de ativação do 1º acesso do painel (M4)", () => {
  it("é estável, legível (4 grupos de 5) e diferente por admin e por chave", () => {
    const code = activationCodeFor(ID, KEY);
    expect(code).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    expect(activationCodeFor(ID, KEY)).toBe(code);
    expect(activationCodeFor("outro-admin", KEY)).not.toBe(code);
    expect(activationCodeFor(ID, randomBytes(32))).not.toBe(code);
  });

  it("aceita com ou sem hífens e em minúsculas; recusa ausente, errado ou de outro admin", () => {
    const code = activationCodeFor(ID, KEY);
    expect(verifyActivationCode(ID, code, KEY)).toBe(true);
    expect(verifyActivationCode(ID, code.replaceAll("-", "").toLowerCase(), KEY)).toBe(true);
    expect(verifyActivationCode(ID, undefined, KEY)).toBe(false);
    expect(verifyActivationCode(ID, "", KEY)).toBe(false);
    expect(verifyActivationCode(ID, "AAAAA-AAAAA-AAAAA-AAAAA", KEY)).toBe(false);
    expect(verifyActivationCode("outro-admin", code, KEY)).toBe(false);
  });

  it("é exigido por padrão só em produção; a variável manda", () => {
    expect(activationRequired({ NODE_ENV: "production" })).toBe(true);
    expect(activationRequired({ NODE_ENV: "development" })).toBe(false);
    expect(activationRequired({ NODE_ENV: "test" })).toBe(false);
    expect(activationRequired({ NODE_ENV: "production", ADMIN_REQUIRE_ACTIVATION_CODE: "false" })).toBe(false);
    expect(activationRequired({ NODE_ENV: "development", ADMIN_REQUIRE_ACTIVATION_CODE: "true" })).toBe(true);
  });
});
