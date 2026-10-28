import { effectiveSubscriptionStatus, isAccountSuspended, type SubscriptionStatus } from "@duckzap/contracts/session";
import { schema, type Database } from "@duckzap/db";
import { and, inArray, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { ChannelCredentials } from "../../lib/messaging";
import { withOrgRealtime } from "../../lib/realtime";
import { buildRef, readCredentials, sealCredentials } from "./repo";
import type { ChannelsRuntime } from "./runtime";
import { applyStatus } from "./service";

/**
 * Conta suspensa desconecta o WhatsApp. Idempotente: só olha canais ainda não desconectados. Nunca apaga conversas.
 *  - WhatsApp por QR (Evolution): desloga a sessão no provedor e esquece o token da instância (precisa ler o QR de novo);
 *  - API oficial (Meta): só marca desconectado, SEM apagar credenciais;
 *  - o canal é marcado `disconnected` mesmo se o provedor falhar (nesse caso as credenciais ficam, para o logout poder ser refeito
 *    à mão pela tela de Canais) e a falha vai para o log.
 * Reativar a assinatura NÃO reconecta sozinho.
 */
export type SuspensionResult = { organizations: number; disconnected: number; providerFailures: number };

type LapsedRow = { organization_id: string; status: string; current_period_end: Date | string; disabled_at: Date | string | null };

export async function suspendLapsedAccounts(db: Database, rt: ChannelsRuntime, options: { limit?: number } = {}): Promise<SuspensionResult> {
  const result: SuspensionResult = { organizations: 0, disconnected: 0, providerFailures: 0 };
  const now = rt.now();
  const rows = await db.execute<LapsedRow>(sql`select organization_id, status, current_period_end, disabled_at from public.dz_orgs_with_live_channels_and_lapsed_subscription(${options.limit ?? 100})`);
  for (const r of rows) {
    const status = effectiveSubscriptionStatus({
      status: r.status as SubscriptionStatus,
      currentPeriodEnd: new Date(r.current_period_end),
      disabledAt: r.disabled_at ? new Date(r.disabled_at) : null,
      now,
    });
    if (!isAccountSuspended(status)) continue;
    result.organizations++;
    try {
      const part = await suspendOrganization(db, rt, r.organization_id);
      result.disconnected += part.disconnected;
      result.providerFailures += part.providerFailures;
    } catch (error) {
      rt.log.error("channels.suspend_failed", { organizationId: r.organization_id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return result;
}

export async function suspendOrganization(db: Database, rt: ChannelsRuntime, organizationId: string): Promise<{ disconnected: number; providerFailures: number }> {
  const t = schema.channels;
  const live = await withOrgRealtime(db, organizationId, (tx) =>
    tx.select().from(t).where(and(inArray(t.type, ["whatsapp_qr", "whatsapp_official"]), ne(t.status, "disconnected"))),
  );
  let providerFailures = 0;
  for (const row of live) {
    const provider = rt.providers.get(row.provider);
    let credentials: ChannelCredentials = {};
    try {
      credentials = readCredentials(row);
    } catch {
      // credencial ilegível: só marca desconectado
    }
    let providerOk = true;
    if (row.type === "whatsapp_qr" && provider) {
      try {
        await provider.disconnect(buildRef(row, rt, credentials));
      } catch {
        providerOk = false;
        providerFailures++;
      }
    }
    await withOrgRealtime(db, organizationId, async (tx) => {
      const extra =
        row.type === "whatsapp_qr" && providerOk
          ? (() => {
              const kept: ChannelCredentials = {};
              for (const [key, value] of Object.entries(credentials)) {
                if (key !== "instanceToken" && key !== "accessToken" && typeof value === "string") kept[key] = value;
              }
              return { credentialsEnc: sealCredentials(organizationId, kept), credentialsHint: null, qrPayloadEnc: null, qrExpiresAt: null };
            })()
          : {};
      await applyStatus(tx, row, "disconnected", extra);
    });
    rt.log.warn("channels.suspended", { organizationId, channelId: row.id, reason: "suspended", providerOk });
  }
  return { disconnected: live.length, providerFailures };
}
