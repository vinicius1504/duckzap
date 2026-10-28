import { createDb, type Database } from "@duckzap/db";
import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** papel duckzap_admin (BYPASSRLS, privilégios mínimos). Sem isto as rotas /v1/admin respondem 503. */
  ADMIN_DATABASE_URL: z.string().min(1).optional(),
  /** origens do painel; nas rotas de escrita o cabeçalho Origin precisa estar aqui (defesa extra contra CSRF) */
  ADMIN_ORIGINS: z
    .string()
    .default("http://localhost:3002")
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  /** IPs/CIDRs permitidos; vazio = sem restrição */
  ADMIN_IP_ALLOWLIST: csv,
  /** true só atrás de proxy confiável que acrescenta o IP real ao FIM de x-forwarded-for */
  ADMIN_TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type AdminConfig = z.infer<typeof configSchema>;

/** Lido no próprio módulo (convenção): não depende de src/env.ts. */
export function loadAdminConfig(source: NodeJS.ProcessEnv = process.env): AdminConfig {
  return configSchema.parse(source);
}

let cached: { url: string; db: Database } | null = null;

/**
 * Conexão SEPARADA do painel (papel duckzap_admin). Fica fora do `deps.db` de propósito:
 * o código do painel nunca passa por `withOrg` e o código dos clientes nunca vê este pool.
 * Criada sob demanda para a API subir mesmo sem a variável configurada.
 */
export function getAdminDb(config: AdminConfig): Database | null {
  if (!config.ADMIN_DATABASE_URL) return null;
  if (cached?.url === config.ADMIN_DATABASE_URL) return cached.db;
  cached = { url: config.ADMIN_DATABASE_URL, db: createDb(config.ADMIN_DATABASE_URL, { max: 5 }).db };
  return cached.db;
}
