import { z } from "zod";

// Variáveis de ambiente do módulo (lidas aqui, sem editar src/env.ts). Documentadas em apps/api/.env.example.
const schema = z.object({
  /**
   * "inline" (padrão): a própria API varre as empresas com campanhas vencidas a cada CAMPAIGNS_SWEEP_SECONDS
   * (`startBackgroundJobs` em src/jobs.ts). O estado está no banco (`campaigns.next_send_at`) e o tick é idempotente
   * com trava por linha, então reiniciar a API ou ter várias instâncias é seguro. "off" só se explícito (ex.: um
   * apps/worker dedicado faz o sweep).
   */
  CAMPAIGNS_SCHEDULER: z.enum(["off", "inline"]).default("inline"),
  CAMPAIGNS_SWEEP_SECONDS: z.coerce.number().int().min(1).max(300).default(15),
  /** Pedidos de geração de variações por minuto por empresa (custo de IA). */
  CAMPAIGNS_VARIATIONS_PER_MINUTE: z.coerce.number().int().min(1).max(60).default(6),
});

export type CampaignsConfig = z.infer<typeof schema>;

export function loadCampaignsConfig(source: NodeJS.ProcessEnv = process.env): CampaignsConfig {
  return schema.parse(source);
}
