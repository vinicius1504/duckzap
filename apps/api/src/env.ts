import { z } from "zod";
import { loadMasterKeys } from "./lib/crypto";

const LLM_PROVIDERS = ["anthropic", "openai", "gemini", "groq", "fake"] as const;
const llmProvider = (name: string) =>
  z.enum(LLM_PROVIDERS, { error: `${name} inválido. Use um destes: ${LLM_PROVIDERS.join(", ")}.` });

/** "true"/"false"/"1"/"0" (e variantes) → boolean; vazio = undefined (o padrão é decidido em parseEnv). */
const flag = () =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      const v = value?.trim().toLowerCase();
      if (!v) return undefined;
      if (["true", "1", "yes", "sim"].includes(v)) return true;
      if (["false", "0", "no", "nao", "não"].includes(v)) return false;
      ctx.addIssue({ code: "custom", message: 'Use "true" ou "false".' });
      return z.NEVER;
    });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  /** papel do app no banco, SEM BYPASSRLS (§3.4) */
  DATABASE_URL: z.url(),
  /** URL pública do front pela qual o navegador chega na API (proxy /api) */
  PUBLIC_API_URL: z.url().default("http://localhost:3000/api"),
  /** URL pública do app das empresas (links de e-mail) */
  WEB_URL: z.url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().min(32),
  SMTP_URL: z.string().default("smtp://127.0.0.1:1026"),
  MAIL_FROM: z.string().default("DuckChat <nao-responda@duckchat.local>"),
  /** Para onde vão os chamados do suporte (Ajuda → "Falar com a gente"). Vazio = só registra em log. */
  SUPPORT_EMAIL: z.string().optional(),
  WEB_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  /** Cifra de segredos (§5.2): validada no boot com a mesma regra de lib/crypto.ts */
  ENCRYPTION_KEY: z.string().optional(),
  ENCRYPTION_KEYS: z.string().optional(),
  /** IA: nomes validados aqui só para a mensagem de erro ser amigável; a configuração completa é `llmEnvSchema`. */
  LLM_PROVIDER: llmProvider("LLM_PROVIDER").default("fake"),
  LLM_FALLBACK_PROVIDER: llmProvider("LLM_FALLBACK_PROVIDER").optional(),
  /** Evolution API (canal por QR code) */
  EVOLUTION_URL: z.string().optional(),
  EVOLUTION_API_KEY: z.string().optional(),
  /** /openapi.json: padrão só com sessão; "true" libera para todos (só dev/documentação). */
  OPENAPI_PUBLIC: flag(),
});

type Parsed = z.infer<typeof envSchema>;
/** Campos acrescentados depois (IA, 2FA, openapi) são opcionais no tipo: testes montam `Env` à mão sem eles. */
export type Env = Omit<Parsed, "LLM_PROVIDER" | "OPENAPI_PUBLIC"> & {
  LLM_PROVIDER?: Parsed["LLM_PROVIDER"];
  OPENAPI_PUBLIC?: boolean;
};

export type EnvResult = { ok: true; env: Env; warnings: string[] } | { ok: false; errors: string[] };

/** `VAR=` vazia no .env vale como "não definida" (senão um enum opcional vazio derruba o boot). */
export function withoutEmpty(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""));
}

/** Valida sem encerrar o processo (testável). `loadEnv` é a versão do boot. */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): EnvResult {
  const parsed = envSchema.safeParse(withoutEmpty(source));
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`);
    return { ok: false, errors };
  }
  const data = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = data.NODE_ENV === "production";

  try {
    loadMasterKeys(source);
  } catch (error) {
    errors.push(`ENCRYPTION_KEY: ${error instanceof Error ? error.message : "inválida."}`);
  }

  if (data.EVOLUTION_URL && !data.EVOLUTION_API_KEY) {
    const message = "EVOLUTION_URL está definida mas EVOLUTION_API_KEY não: canais por QR code não vão conectar.";
    if (production) errors.push(message);
    else warnings.push(message);
  }
  if (production) {
    if (data.WEB_ORIGINS.some((origin) => origin.startsWith("http://") && !origin.includes("localhost"))) {
      warnings.push("WEB_ORIGINS tem origem http:// em produção; use https://.");
    }
    if (!data.WEB_URL.startsWith("https://")) warnings.push("WEB_URL deveria ser https:// em produção.");
    if (!data.SUPPORT_EMAIL) warnings.push("SUPPORT_EMAIL não definido: chamados de suporte só serão registrados em log.");
  }
  if (errors.length > 0) return { ok: false, errors };

  const env: Env = {
    ...data,
    OPENAPI_PUBLIC: data.OPENAPI_PUBLIC ?? false,
  };
  return { ok: true, env, warnings };
}

// a API não sobe com configuração inválida (§5.3)
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = parseEnv(source);
  if (!result.ok) {
    console.error(["Configuração inválida. Corrija o .env e suba de novo:", ...result.errors.map((line) => `  - ${line}`)].join("\n"));
    process.exit(1);
  }
  for (const warning of result.warnings) console.warn(`[config] ${warning}`);
  return result.env;
}
