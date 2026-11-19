import { describe, expect, it } from "vitest";
import { normalizeCode, otherMethod, signInMethod } from "./rules";

describe("2FA: regras puras", () => {
  it("login: app quando a conta tem app conferido; e-mail só quando é o único método", () => {
    // o Better Auth lista "otp" para todo mundo quando o envio por e-mail está configurado
    expect(signInMethod(["totp", "otp"])).toBe("app");
    expect(signInMethod(["totp"])).toBe("app");
    expect(signInMethod(["otp"])).toBe("email");
    // resposta antiga/sem lista: segue pedindo o app, como antes
    expect(signInMethod(undefined)).toBe("app");
    expect(signInMethod([])).toBe("app");
    expect(signInMethod("otp")).toBe("app");
  });

  it("código digitado ou colado com espaço/traço", () => {
    expect(normalizeCode(" 123 456 ")).toBe("123456");
    expect(normalizeCode("123-456")).toBe("123456");
  });

  it("trocar de método", () => {
    expect(otherMethod("app")).toBe("email");
    expect(otherMethod("email")).toBe("app");
  });
});
