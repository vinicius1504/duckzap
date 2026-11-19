import type { OnboardingState } from "@duckzap/contracts/onboarding";
import { schema, withOrg, type Database } from "@duckzap/db";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { loadTwoFactorStatus } from "../settings/account";

// Progresso do cadastro DERIVADO DO BANCO (nada fica na memória do front, que some a cada deploy):
//   Segurança → 2FA ativo, ou "pular" escolhido (`user.onboarding_security_skipped_at`); da pessoa, não da empresa.
//   WhatsApp → a empresa tem canal de WhatsApp CONECTADO, ou escolheu "pular" (`organization.onboarding_whatsapp_skipped_at`);
//              canal criado mas ainda não lido (QR na tela) mantém o passo em aberto.
//   Agente   → o agente mais antigo da empresa (refazer o passo atualiza ele em vez de criar outro).
//   Concluído → `organization.onboarding_completed_at` (POST /v1/onboarding/complete; backfill da 0016 para as antigas).

const WHATSAPP_TYPES = ["whatsapp_qr", "whatsapp_official"];

type Progress = Pick<OnboardingState, "whatsapp" | "channelId" | "agentId" | "completedAt">;

export async function loadProgress(
  db: Database,
  org: { id: string; onboardingCompletedAt: Date | null; onboardingWhatsappSkippedAt: Date | null },
): Promise<Progress> {
  const { channel, agent } = await withOrg(db, org.id, async (tx) => {
    // o conectado primeiro; senão o mais recente (o QR gerado e ainda não lido)
    const [channel] = await tx
      .select({ id: schema.channels.id, type: schema.channels.type, status: schema.channels.status, address: schema.channels.address })
      .from(schema.channels)
      .where(inArray(schema.channels.type, WHATSAPP_TYPES))
      .orderBy(sql`(${schema.channels.status} = 'connected') desc`, desc(schema.channels.createdAt))
      .limit(1);
    const [agent] = await tx.select({ id: schema.agents.id }).from(schema.agents).orderBy(asc(schema.agents.createdAt)).limit(1);
    return { channel, agent };
  });

  const method = channel?.type === "whatsapp_official" ? "official_api" : "qr_code";
  let whatsapp: Progress["whatsapp"] = null;
  if (channel?.status === "connected") whatsapp = { method, status: "connected", phone: channel.address };
  else if (org.onboardingWhatsappSkippedAt) whatsapp = { method, status: "skipped", phone: null };

  return {
    whatsapp,
    channelId: channel?.id ?? null,
    agentId: agent?.id ?? null,
    completedAt: org.onboardingCompletedAt?.toISOString() ?? null,
  };
}

/** Marca o cadastro como concluído. Idempotente: a 2ª chamada devolve a MESMA data (não reescreve). */
export async function markCompleted(db: Database, organizationId: string, now = new Date()): Promise<Date> {
  const [row] = await db
    .update(schema.organization)
    .set({ onboardingCompletedAt: sql`coalesce(${schema.organization.onboardingCompletedAt}, ${now.toISOString()}::timestamptz)` })
    .where(eq(schema.organization.id, organizationId))
    .returning({ completedAt: schema.organization.onboardingCompletedAt });
  if (!row?.completedAt) throw new Error("Empresa não encontrada ao concluir o cadastro");
  return row.completedAt;
}

/**
 * Passo "Proteja sua conta" (da pessoa, antes da empresa): feito com o 2FA ativo (qualquer método) ou com "Pular por
 * enquanto" (`user.onboarding_security_skipped_at`, 0017). Ativar ou desativar depois em Ajustes não reabre o passo pulado.
 */
export async function loadSecurityStep(db: Database, userId: string): Promise<OnboardingState["security"]> {
  const [row] = await db
    .select({ skippedAt: schema.user.onboardingSecuritySkippedAt })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  const { enabled, method } = await loadTwoFactorStatus(db, userId);
  return { twoFactorEnabled: enabled, method, skippedAt: row?.skippedAt?.toISOString() ?? null };
}

/** "Pular por enquanto" o 2FA no cadastro: guardado na pessoa (idempotente: a 2ª vez mantém a 1ª data). */
export async function markSecuritySkipped(db: Database, userId: string, now = new Date()): Promise<void> {
  await db
    .update(schema.user)
    .set({ onboardingSecuritySkippedAt: sql`coalesce(${schema.user.onboardingSecuritySkippedAt}, ${now.toISOString()}::timestamptz)` })
    .where(eq(schema.user.id, userId));
}

/** "Pular" o WhatsApp no cadastro: guardado na empresa (idempotente; conectar depois não depende disto). */
export async function markWhatsappSkipped(db: Database, organizationId: string, now = new Date()): Promise<void> {
  await db
    .update(schema.organization)
    .set({ onboardingWhatsappSkippedAt: sql`coalesce(${schema.organization.onboardingWhatsappSkippedAt}, ${now.toISOString()}::timestamptz)` })
    .where(eq(schema.organization.id, organizationId));
}
