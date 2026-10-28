import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const base = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: "postgres://duckzap_app:x@127.0.0.1:5433/duckzap",
  BETTER_AUTH_SECRET: "x".repeat(40),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
});

describe("parseEnv — validação no boot", () => {
  it("aceita a configuração mínima e aplica padrões", () => {
    const result = parseEnv(base());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.PORT).toBe(4000);
      expect(result.env.OPENAPI_PUBLIC).toBe(false);
      expect(result.env.LLM_PROVIDER).toBe("fake");
    }
  });

  it("recusa ENCRYPTION_KEY ausente", () => {
    const source = base();
    delete source.ENCRYPTION_KEY;
    const result = parseEnv(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(/ENCRYPTION_KEY/);
  });

  it("recusa ENCRYPTION_KEY com tamanho errado", () => {
    const result = parseEnv({ ...base(), ENCRYPTION_KEY: "curta" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(/32 bytes/);
  });

  it("aceita só ENCRYPTION_KEYS (rotação)", () => {
    const source = base();
    delete source.ENCRYPTION_KEY;
    source.ENCRYPTION_KEYS = `k1:${randomBytes(32).toString("base64")}`;
    expect(parseEnv(source).ok).toBe(true);
  });

  it("LLM_PROVIDER inválido dá mensagem amigável (sem ZodError cru)", () => {
    const result = parseEnv({ ...base(), LLM_PROVIDER: "claude" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/^LLM_PROVIDER: LLM_PROVIDER inválido\. Use um destes: anthropic, openai, gemini, groq, fake\.$/);
    }
  });

  it("LLM_FALLBACK_PROVIDER inválido também", () => {
    const result = parseEnv({ ...base(), LLM_FALLBACK_PROVIDER: "x" });
    expect(result.ok).toBe(false);
  });

  it("Evolution sem chave: aviso em dev, erro em produção", () => {
    const dev = parseEnv({ ...base(), EVOLUTION_URL: "http://localhost:8081" });
    expect(dev.ok && dev.warnings.some((w) => w.includes("EVOLUTION_API_KEY"))).toBe(true);
    const prod = parseEnv({ ...base(), NODE_ENV: "production", EVOLUTION_URL: "http://evo:8080" });
    expect(prod.ok).toBe(false);
  });

  it("OPENAPI_PUBLIC aceita true/false e recusa lixo", () => {
    const on = parseEnv({ ...base(), OPENAPI_PUBLIC: "true" });
    expect(on.ok && on.env.OPENAPI_PUBLIC).toBe(true);
    expect(parseEnv({ ...base(), OPENAPI_PUBLIC: "talvez" }).ok).toBe(false);
  });

  it("DATABASE_URL e segredo do Better Auth continuam obrigatórios", () => {
    expect(parseEnv({ ...base(), DATABASE_URL: "" }).ok).toBe(false);
    expect(parseEnv({ ...base(), BETTER_AUTH_SECRET: "curto" }).ok).toBe(false);
  });
});

describe("parseEnv — variáveis vazias do .env.example", () => {
  it("VAR= vazia vale como não definida (enum opcional vazio não derruba o boot)", () => {
    const result = parseEnv({ ...base(), LLM_FALLBACK_PROVIDER: "", SUPPORT_EMAIL: "", ENCRYPTION_KEYS: "", OPENAPI_PUBLIC: "", PORT: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.env.PORT).toBe(4000);
  });
});
