import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totpCode, verifyTotp } from "./totp";

// segredo "12345678901234567890" dos vetores do RFC 4226/6238
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("bate com os vetores do RFC 4226 (HOTP)", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it("bate com o vetor do RFC 6238 (T=59 s => 287082 nos 6 últimos dígitos)", () => {
    expect(totpCode(RFC_SECRET, 59_000)).toBe("287082");
    expect(totpCode(RFC_SECRET, 1_111_111_109_000)).toBe("081804");
  });

  it("base32 faz ida e volta", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
  });

  it("aceita o código atual e a janela de ±1 passo, recusa fora dela", () => {
    const now = 1_700_000_000_000;
    const at = (offsetSteps: number) => totpCode(RFC_SECRET, now + offsetSteps * 30_000);
    expect(verifyTotp({ secret: RFC_SECRET, code: at(0), nowMs: now })).not.toBeNull();
    expect(verifyTotp({ secret: RFC_SECRET, code: at(-1), nowMs: now })).not.toBeNull();
    expect(verifyTotp({ secret: RFC_SECRET, code: at(1), nowMs: now })).not.toBeNull();
    expect(verifyTotp({ secret: RFC_SECRET, code: at(-2), nowMs: now })).toBeNull();
    expect(verifyTotp({ secret: RFC_SECRET, code: at(2), nowMs: now })).toBeNull();
  });

  it("devolve o passo que bateu e impede reuso (minStep)", () => {
    const now = 1_700_000_000_000;
    const code = totpCode(RFC_SECRET, now);
    const step = verifyTotp({ secret: RFC_SECRET, code, nowMs: now });
    expect(step).toBe(Math.floor(now / 30_000));
    expect(verifyTotp({ secret: RFC_SECRET, code, nowMs: now, minStep: step })).toBeNull();
    expect(verifyTotp({ secret: RFC_SECRET, code, nowMs: now, minStep: (step ?? 0) - 1 })).toBe(step);
  });

  it("recusa formato inválido e código de outro segredo", () => {
    const now = 1_700_000_000_000;
    for (const code of ["", "12345", "1234567", "abcdef", "12 456", " 123456"]) {
      expect(verifyTotp({ secret: RFC_SECRET, code, nowMs: now })).toBeNull();
    }
    const other = generateTotpSecret();
    expect(verifyTotp({ secret: RFC_SECRET, code: totpCode(other, now), nowMs: now })).toBeNull();
  });

  it("monta o otpauth:// para o app autenticador", () => {
    const uri = otpauthUri({ secret: RFC_SECRET, account: "a@b.com", issuer: "DuckChat Admin" });
    expect(uri.startsWith("otpauth://totp/DuckChat%20Admin:a%40b.com?")).toBe(true);
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
