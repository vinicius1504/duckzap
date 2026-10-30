import { contactInputSchema } from "@duckzap/contracts/contacts";
import { emailError, emailSuggestion, formatPhoneInput, isValidEmail, isValidPhone, normalizePhone, phoneError } from "@duckzap/contracts/validation";
import { z } from "zod";
import { describe, expect, it } from "vitest";

describe("telefone", () => {
  it.each([
    "67 99812-3456",
    "(67) 99812-3456",
    "67998123456",
    "+55 67 99812-3456",
    "5567998123456",
    "(11) 4000-1234", // fixo
    "6733334444",
    "+1 415 555 2671", // fora do Brasil
    "",
    "   ",
  ])("aceita %j", (value) => {
    expect(isValidPhone(value)).toBe(true);
  });

  it.each([
    "123",
    "99812-3456", // sem DDD
    "(00) 99812-3456", // DDD inexistente
    "(10) 99812-3456",
    "(67) 89812-3456", // 11 dígitos, mas o celular começa com 9
    "(67) 1333-4444", // fixo não começa com 0 ou 1
    "+55 67 9981",
    "+",
    "abc",
    "559999999999999",
    "+1234567", // curto demais para o padrão internacional
  ])("recusa %j", (value) => {
    expect(isValidPhone(value)).toBe(false);
  });

  it("devolve a mensagem só quando precisa", () => {
    expect(phoneError("")).toBeNull();
    expect(phoneError("", { required: true })).toBe("Informe o telefone.");
    expect(phoneError("12")).toMatch(/Telefone inválido/);
    expect(phoneError("(67) 99812-3456")).toBeNull();
  });

  it("normaliza para dígitos (mantém o +)", () => {
    expect(normalizePhone(" (67) 99812-3456 ")).toBe("67998123456");
    expect(normalizePhone("+55 (67) 99812-3456")).toBe("+5567998123456");
  });

  it.each([
    ["", ""],
    ["6", "(6"],
    ["67", "(67"],
    ["679", "(67) 9"],
    ["6799812", "(67) 9981-2"],
    ["67998123", "(67) 9981-23"],
    ["67998123456", "(67) 99812-3456"],
    ["6733334444", "(67) 3333-4444"],
    ["67998123456999", "(67) 99812-3456"],
    ["5567998123456", "(67) 99812-3456"],
    ["+5567998123456", "+55 (67) 99812-3456"],
    ["+14155552671", "+14155552671"],
  ])("máscara %j → %j", (raw, shown) => {
    expect(formatPhoneInput(raw)).toBe(shown);
  });

  it("apagar não prende o cursor em enfeites: a máscara é estável em todos os prefixos", () => {
    const full = formatPhoneInput("67998123456");
    for (let i = full.length; i >= 0; i--) {
      const shown = formatPhoneInput(full.slice(0, i));
      // reaplicar a máscara no que já está na tela não muda nada
      expect(formatPhoneInput(shown)).toBe(shown);
      // e nunca sobra ")" ou "-" soltos no fim
      expect(shown).not.toMatch(/[-) ]$/);
    }
  });

  it("a API aplica a mesma regra e guarda só dígitos", () => {
    const base = { name: "Ana", email: "", instagram: "", isCustomer: false, tagIds: [], origin: "service", originNote: "", ownerId: null, birthDate: "" };
    const ok = contactInputSchema.safeParse({ ...base, phone: "(67) 99812-3456" });
    expect(ok.success && ok.data.phone).toBe("67998123456");
    const bad = contactInputSchema.safeParse({ ...base, phone: "(67) 1234" });
    expect(bad.success).toBe(false);
  });
});

describe("e-mail", () => {
  it.each(["ana@empresa.com.br", "ana.silva+loja@gmail.com", "a_b@sub.dominio.io", "ANA@EMPRESA.COM"])("aceita %j", (value) => {
    expect(isValidEmail(value)).toBe(true);
  });

  it.each(["", "ana", "ana@", "@empresa.com", "ana@empresa", "ana@empresa.", "ana empresa@x.com", "ana..silva@x.com", ".ana@x.com", "ana@-x.com", "ana@x.c"])(
    "recusa %j",
    (value) => {
      expect(isValidEmail(value)).toBe(false);
    },
  );

  it("decide igual ao z.email() que a API usa", () => {
    const samples = ["ana@empresa.com.br", "ana@x", "a.b+c@d-e.fg", "ana@@x.com", "ana@x_y.com", "ana'o@x.com", "ana@x.com ", "a@b.co", "-ana@x.com", "ana.@x.com"];
    for (const value of samples) {
      expect(isValidEmail(value), value).toBe(z.email().safeParse(value.trim()).success);
    }
  });

  it("mensagem e sugestão de domínio", () => {
    expect(emailError("")).toBeNull();
    expect(emailError("", { required: true })).toBe("Informe o e-mail.");
    expect(emailError("ana@")).toMatch(/E-mail inválido/);
    expect(emailError("ana@gmail.com")).toBeNull();
    expect(emailSuggestion("ana@gmial.com")).toBe("ana@gmail.com");
    expect(emailSuggestion("ana@Gmail.con")).toBe("ana@gmail.com");
    expect(emailSuggestion("ana@gmail.com")).toBeNull();
    expect(emailSuggestion("ana")).toBeNull();
  });
});
