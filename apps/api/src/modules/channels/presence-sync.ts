import { schema, withOrg, type Database } from "@duckzap/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { buildRef } from "./repo";
import type { ChannelsRuntime } from "./runtime";

export type PresenceSyncResult = { channels: number; updated: number; unchanged: number; failed: number };

/**
 * Manutenção: instâncias da Evolution criadas ANTES do `PRESENCE_UPDATE` existir foram registradas sem o evento, então o
 * "cliente digitando…" nunca chegaria. Para cada canal QR conectado, `syncWebhook` consulta o webhook da instância
 * (`GET /webhook/find`) e só reaplica (`POST /webhook/set`) se faltar o evento ou a URL mudou: rodar de novo é inofensivo.
 *
 * Como a API não tem uma função SECURITY DEFINER que liste canais de todas as empresas (e não criamos migração para isso),
 * percorre as empresas em páginas por id (como `sweepInactivity`) e lê os canais de cada uma em `withOrg`, sob RLS.
 * Falha de uma instância (Evolution fora do ar, instância apagada) só conta e segue. NADA sensível vai para o log
 * (nem URL de webhook, nem tokens): só contagens.
 */
export async function syncPresenceWebhooks(db: Database, rt: ChannelsRuntime, options: { pageSize?: number } = {}): Promise<PresenceSyncResult> {
  const result: PresenceSyncResult = { channels: 0, updated: 0, unchanged: 0, failed: 0 };
  if (!rt.config.presenceWebhookSync) return result;
  const provider = rt.providers.get("evolution");
  if (!provider?.syncWebhook || !provider.capabilities().presence) return result;

  const pageSize = options.pageSize ?? 200;
  let after: string | null = null;
  for (;;) {
    const page: { id: string }[] = await db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(after ? sql`${schema.organization.id} > ${after}` : undefined)
      .orderBy(asc(schema.organization.id))
      .limit(pageSize);
    if (page.length === 0) break;
    for (const org of page) {
      try {
        const rows = await withOrg(db, org.id, (tx) =>
          tx
            .select()
            .from(schema.channels)
            .where(and(eq(schema.channels.organizationId, org.id), eq(schema.channels.type, "whatsapp_qr"), eq(schema.channels.status, "connected"))),
        );
        for (const row of rows) {
          result.channels++;
          try {
            const ref = buildRef(row, rt);
            if (!ref.credentials.instanceName) {
              result.failed++;
              continue;
            }
            const outcome = await provider.syncWebhook(ref);
            result[outcome]++;
          } catch (error) {
            result.failed++;
            rt.log.warn("channels.presence_sync.failed", { error: error instanceof Error ? error.name : "unknown" });
          }
        }
      } catch (error) {
        result.failed++;
        rt.log.warn("channels.presence_sync.org_failed", { error: error instanceof Error ? error.name : "unknown" });
      }
    }
    after = page[page.length - 1]?.id ?? null;
    if (page.length < pageSize) break;
  }
  return result;
}
