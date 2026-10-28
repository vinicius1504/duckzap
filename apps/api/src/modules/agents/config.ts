import { z } from "zod";

/** Variáveis do módulo Agentes (lidas aqui, sem mexer em src/env.ts). Documentadas em apps/api/.env.example. */
const schema = z.object({
  /** Limite do simulador por empresa (cada teste gasta tokens de verdade quando há provedor configurado). */
  AGENTS_SIMULATOR_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** Gerações de perfil do agente por empresa por minuto (cada uma gasta milhares de tokens do modelo "smart"). */
  AGENTS_GENERATOR_PER_MINUTE: z.coerce.number().int().positive().default(5),
  /** Domínios que os agentes podem citar além dos que aparecem no conhecimento do agente (separados por vírgula). */
  AGENTS_URL_ALLOWLIST: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((d) => d.trim()).filter(Boolean)),
  /** Tamanho alvo (caracteres) de cada trecho de conhecimento. */
  AGENTS_CHUNK_CHARS: z.coerce.number().int().min(200).max(4000).default(900),
});

export type AgentsConfig = z.infer<typeof schema>;

export function loadAgentsConfig(source: NodeJS.ProcessEnv = process.env): AgentsConfig {
  return schema.parse(source);
}
