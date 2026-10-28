import { z } from "zod";

/**
 * Configuração da publicação em tempo real (lida aqui, sem mexer em src/env.ts). Documentada em apps/api/.env.example.
 * `REDIS_URL` é opcional: sem ela a API funciona normalmente e simplesmente não publica eventos (a tela só não atualiza sozinha).
 */
const redisUrl = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "redis:" || url.protocol === "rediss:";
    } catch {
      return false;
    }
  });

export type RealtimeConfig = { redisUrl: string | null; warning: string | null };

/** Nunca lança nem devolve o valor da URL em mensagem (pode conter senha). */
export function loadRealtimeConfig(source: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  const raw = source.REDIS_URL;
  if (raw === undefined || raw.trim() === "") {
    return { redisUrl: null, warning: "REDIS_URL não definida: eventos em tempo real desligados (a API segue normalmente)." };
  }
  const parsed = redisUrl.safeParse(raw);
  if (!parsed.success) {
    return { redisUrl: null, warning: "REDIS_URL inválida (use redis://… ou rediss://…): eventos em tempo real desligados." };
  }
  return { redisUrl: parsed.data, warning: null };
}
