import { schema, type Database, type Transaction } from "@duckzap/db";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { dispatchInbound, hasInboundHandlers } from "../../lib/inbound";
import { inboundEventSchema, type ConnectionStatus, type InboundEvent } from "../../lib/messaging";
import { encryptSecret } from "../../lib/crypto";
import { queueRealtime, withOrgRealtime } from "../../lib/realtime";
import { buildRef, findChannel } from "./repo";
import type { ChannelsRuntime } from "./runtime";
import { isSendingPausedForOrg } from "./sending";
import { applyStatus } from "./service";

export const MAX_ATTEMPTS = 5;

/**
 * LGPD (§5.5): o corpo cru e o evento canônico têm telefone, nome e texto do cliente. Depois de processado (a mensagem já
 * está em `messages`, que é apagada com o contato), só ficam ids e tipo: o suficiente para deduplicar e investigar.
 * `external_id`/`kind` já são colunas próprias, então o jsonb minimizado carrega apenas o tipo e a marca.
 */
export function minimizedEvent(kind: string, event?: unknown): { minimized: true; type: string; at?: string } {
  const at = event && typeof event === "object" && "at" in event && typeof (event as { at: unknown }).at === "string" ? (event as { at: string }).at : undefined;
  return { minimized: true, type: kind, ...(at ? { at } : {}) };
}

const MINIMIZED_SQL = sql`jsonb_build_object('minimized', true, 'type', kind)`;

/** Chave de deduplicação por canal. Mensagens e status se repetem na mesma forma quando o provedor reenvia. */
export function eventKey(event: InboundEvent): string {
  switch (event.type) {
    case "message":
      return `msg:${event.externalId}`;
    case "status":
      return `status:${event.externalId}:${event.status}`;
    case "presence":
      // nunca gravada (o webhook a separa antes); a chave existe só para o `switch` ser exaustivo
      return `presence:${event.from}:${event.at}`;
    case "connection":
      return `conn:${event.status}:${event.at}${event.qrCode ? `:${createHash("sha256").update(event.qrCode).digest("hex").slice(0, 16)}` : ""}`;
  }
}

export const unparsedKey = (rawBody: string) => `unparsed:${createHash("sha256").update(rawBody).digest("hex")}`;

/** Corpo cru como jsonb: se não for JSON, guarda o texto (limitado) para investigação. */
export function rawPayload(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return { unparsedBody: rawBody.slice(0, 10_000) };
  }
}

export type RecordInput = { organizationId: string; channelId: string; rawBody: string; events: InboundEvent[]; parseFailed: boolean };

/**
 * Passo 2 do fluxo §3.3: grava o evento bruto ANTES de processar. `ON CONFLICT DO NOTHING` em (channel_id, external_id)
 * torna o reenvio do provedor inofensivo. Devolve os ids realmente novos (só eles vão para processamento).
 */
export async function recordInbound(db: Database, input: RecordInput): Promise<{ ids: string[]; duplicates: number }> {
  const payload = rawPayload(input.rawBody);
  const rows: (typeof schema.inboundEvents.$inferInsert)[] = input.parseFailed
    ? [
        {
          id: uuidv7(),
          organizationId: input.organizationId,
          channelId: input.channelId,
          externalId: unparsedKey(input.rawBody),
          kind: "unparsed",
          payload,
          event: null,
          error: "parse_failed",
          // sem evento canônico não há o que reprocessar: fica guardado (dead letter) para análise
          processedAt: new Date(),
          attempts: 0,
        },
      ]
    : input.events
        .filter((event) => event.type !== "presence") // presença é efêmera: jamais vai para `inbound_events`
        .map((event) => ({
        id: uuidv7(),
        organizationId: input.organizationId,
        channelId: input.channelId,
        externalId: eventKey(event),
        kind: event.type,
        payload,
        event,
      }));
  if (rows.length === 0) return { ids: [], duplicates: 0 };

  const inserted = await withOrgRealtime(db, input.organizationId, (tx) =>
    tx.insert(schema.inboundEvents).values(rows).onConflictDoNothing().returning({ id: schema.inboundEvents.id, kind: schema.inboundEvents.kind }),
  );
  return {
    ids: inserted.filter((row) => row.kind !== "unparsed").map((row) => row.id),
    duplicates: rows.length - inserted.length,
  };
}

const errorLabel = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "erro desconhecido");

/**
 * Processa eventos pendentes de UMA empresa (os de `ids`, ou os vencidos). `FOR UPDATE SKIP LOCKED` evita que dois
 * processos peguem o mesmo evento. Falha de um evento não perde nada: guarda o erro, soma tentativa e agenda a próxima.
 */
export async function processInbound(
  db: Database,
  organizationId: string,
  rt: ChannelsRuntime,
  options: { ids?: string[]; limit?: number } = {},
): Promise<{ processed: number; failed: number }> {
  return withOrgRealtime(db, organizationId, async (tx) => {
    const now = rt.now();
    const due = and(
      eq(schema.inboundEvents.organizationId, organizationId),
      isNull(schema.inboundEvents.processedAt),
      lt(schema.inboundEvents.attempts, MAX_ATTEMPTS),
      or(isNull(schema.inboundEvents.nextAttemptAt), sql`${schema.inboundEvents.nextAttemptAt} <= ${now.toISOString()}`),
      options.ids ? inArray(schema.inboundEvents.id, options.ids) : undefined,
    );
    const pending = await tx
      .select()
      .from(schema.inboundEvents)
      .where(due)
      .orderBy(asc(schema.inboundEvents.receivedAt))
      .limit(options.limit ?? 50)
      .for("update", { skipLocked: true });

    // conta suspensa: o evento fica gravado, mas nada é processado (sem resposta da IA, sem envio). Conexão ainda vale.
    const suspended = pending.length > 0 && (await isSendingPausedForOrg(tx, now));
    let processed = 0;
    let failed = 0;
    for (const row of pending) {
      try {
        if (suspended && row.kind !== "connection") continue;
        const event = inboundEventSchema.parse(row.event);
        if (event.type === "connection") {
          await applyConnectionEvent(tx, rt, organizationId, row.channelId, event);
        } else if (hasInboundHandlers()) {
          await dispatchInbound({ organizationId, channelId: row.channelId, event });
        } else {
          // ninguém trata mensagens ainda: deixa pendente, sem gastar tentativa, até um handler ser registrado
          continue;
        }
        await tx
          .update(schema.inboundEvents)
          .set({ processedAt: now, error: null, attempts: row.attempts + 1, nextAttemptAt: null, payload: minimizedEvent(row.kind, row.event), event: minimizedEvent(row.kind, row.event) })
          .where(eq(schema.inboundEvents.id, row.id));
        processed++;
      } catch (error) {
        failed++;
        const attempts = row.attempts + 1;
        const backoffMs = Math.min(2 ** attempts * 30_000, 3_600_000);
        await tx
          .update(schema.inboundEvents)
          .set({
            error: errorLabel(error),
            attempts,
            nextAttemptAt: new Date(now.getTime() + backoffMs),
            // esgotou as tentativas (dead letter): não há mais o que reprocessar, então o dado pessoal sai
            ...(attempts >= MAX_ATTEMPTS ? { payload: minimizedEvent(row.kind, row.event), event: minimizedEvent(row.kind, row.event) } : {}),
          })
          .where(eq(schema.inboundEvents.id, row.id));
        rt.log.warn("channels.inbound.process_failed", { eventId: row.id, attempts });
      }
    }
    return { processed, failed };
  });
}

/**
 * Job de varredura (cron/worker): reprocessa eventos que falharam ou ficaram pendentes (ex.: queda entre gravar e despachar).
 * Descobre as empresas com pendências pela função SECURITY DEFINER `dz_orgs_with_pending_inbound` (ver channels.sql.md);
 * cada empresa é processada dentro de `withOrg`.
 */
export async function reprocessPending(db: Database, rt: ChannelsRuntime, options: { orgLimit?: number; perOrgLimit?: number } = {}) {
  const orgs = await db.execute<{ organization_id: string }>(sql`select organization_id from dz_orgs_with_pending_inbound(${options.orgLimit ?? 50})`);
  const total = { processed: 0, failed: 0, organizations: 0 };
  for (const { organization_id: organizationId } of orgs) {
    const result = await processInbound(db, organizationId, rt, { limit: options.perOrgLimit ?? 50 });
    total.processed += result.processed;
    total.failed += result.failed;
    total.organizations++;
  }
  return total;
}

/** Evento de conexão do provedor → status/QR do canal. Regras anti-oscilação ficam em `nextStatus`. */
async function applyConnectionEvent(
  tx: Transaction,
  rt: ChannelsRuntime,
  organizationId: string,
  channelId: string,
  event: Extract<InboundEvent, { type: "connection" }>,
) {
  const row = await findChannel(tx, organizationId, channelId);
  if (!row) return; // canal apagado entre o recebimento e o processamento
  const current = row.status as ConnectionStatus;

  if (event.qrCode && current !== "connected") {
    await tx
      .update(schema.channels)
      .set({
        qrPayloadEnc: encryptSecret(organizationId, event.qrCode),
        qrExpiresAt: new Date(rt.now().getTime() + rt.config.qrTtlSeconds * 1000),
        updatedAt: sql`now()`,
      })
      .where(eq(schema.channels.id, row.id));
    queueRealtime(tx, organizationId, { type: "channel.status", channelId: row.id, status: current });
  }
  const status = nextStatus(current, event.status);
  if (!status) return;

  let address: string | undefined;
  if (status === "connected") {
    // descobre o número que acabou de conectar (best effort: se falhar, o polling do QR completa depois)
    const info = await rt.providers.get(row.provider)?.inspect?.(buildRef(row, rt)).catch(() => undefined);
    address = info?.address;
  }
  await applyStatus(tx, row, status, address ? { address } : {});
}

/**
 * Qual status aplicar dado o atual e o evento. `null` = ignorar.
 *  - `connected`/`banned` sempre valem;
 *  - `disconnected` só vale se o canal estava conectado (queda real); durante o pareamento a Evolution emite `close` à toa;
 *  - `qr_pending` (novo QR/conectando) não derruba um canal conectado.
 */
export function nextStatus(current: ConnectionStatus, incoming: ConnectionStatus): ConnectionStatus | null {
  if (incoming === current) return null;
  switch (incoming) {
    case "connected":
    case "banned":
      return incoming;
    case "disconnected":
      return current === "connected" ? incoming : null;
    case "qr_pending":
      return current === "connected" ? null : incoming;
    case "awaiting_authorization":
      return null;
  }
}

export type PurgeOptions = {
  /** Processados (ou sem tentativas restantes) mais antigos que isto têm o payload/evento minimizados. Padrão: 30. */
  olderThanDays?: number;
  /** Eventos que não foram interpretados (`unparsed`) guardam o corpo só por pouco tempo. Padrão: 7. */
  unparsedOlderThanDays?: number;
  /** Linhas encerradas mais antigas que isto são apagadas de vez. Padrão: 90. */
  deleteOlderThanDays?: number;
  now?: Date;
  orgPageSize?: number;
};

export type PurgeResult = { organizations: number; minimized: number; deleted: number };

/**
 * Retenção de `inbound_events` (LGPD). Idempotente. Passa por todas as empresas (a tabela `organization` do Better Auth
 * não tem RLS), cada uma dentro de `withOrg`. Nunca toca em evento ainda pendente com tentativas sobrando.
 */
export async function purgeInboundEvents(db: Database, options: PurgeOptions = {}): Promise<PurgeResult> {
  const now = options.now ?? new Date();
  const day = 86_400_000;
  const cutoff = new Date(now.getTime() - (options.olderThanDays ?? 30) * day).toISOString();
  const unparsedCutoff = new Date(now.getTime() - (options.unparsedOlderThanDays ?? 7) * day).toISOString();
  const deleteCutoff = new Date(now.getTime() - (options.deleteOlderThanDays ?? 90) * day).toISOString();
  const pageSize = options.orgPageSize ?? 200;
  const result: PurgeResult = { organizations: 0, minimized: 0, deleted: 0 };
  const t = schema.inboundEvents;
  const finished = sql`(${t.processedAt} is not null or ${t.attempts} >= ${MAX_ATTEMPTS})`;
  const notMinimized = sql`(${t.payload}->>'minimized') is distinct from 'true'`;

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
      result.organizations++;
      const counts = await withOrgRealtime(db, org.id, async (tx) => {
        const minimized = await tx
          .update(t)
          .set({ payload: MINIMIZED_SQL, event: MINIMIZED_SQL })
          .where(
            and(
              eq(t.organizationId, org.id),
              notMinimized,
              or(and(finished, lt(t.receivedAt, new Date(cutoff))), and(eq(t.kind, "unparsed"), lt(t.receivedAt, new Date(unparsedCutoff)))),
            ),
          )
          .returning({ id: t.id });
        const deleted = await tx
          .delete(t)
          .where(and(eq(t.organizationId, org.id), finished, lt(t.receivedAt, new Date(deleteCutoff))))
          .returning({ id: t.id });
        return { minimized: minimized.length, deleted: deleted.length };
      });
      result.minimized += counts.minimized;
      result.deleted += counts.deleted;
    }
    after = page[page.length - 1]?.id ?? null;
    if (page.length < pageSize) break;
  }
  return result;
}

/**
 * Exclusão de contato (LGPD): minimiza os eventos de ENTRADA do telefone dele (compara os últimos 10 dígitos de `from`).
 * Os que ainda estavam pendentes são encerrados (a mensagem não deve virar conversa de quem pediu para ser apagado).
 * Roda na transação da exclusão. Devolve quantos eventos foram minimizados.
 */
export async function eraseInboundEventsForPhones(tx: Transaction, organizationId: string, phones: readonly (string | null)[]): Promise<number> {
  const suffixes = [
    ...new Set(
      phones
        .map((p) => (p ?? "").replace(/\D/g, ""))
        .filter((d) => d.length >= 8)
        .map((d) => d.slice(-10)),
    ),
  ];
  if (suffixes.length === 0) return 0;
  const t = schema.inboundEvents;
  const fromDigits = sql`regexp_replace(coalesce(${t.event}->>'from', ''), '[^0-9]', '', 'g')`;
  const matches = suffixes.map((suffix) => sql`right(${fromDigits}, ${suffix.length}) = ${suffix}`);
  const rows = await tx
    .update(t)
    .set({
      payload: MINIMIZED_SQL,
      event: MINIMIZED_SQL,
      error: sql`case when ${t.processedAt} is null then 'contact_erased' else ${t.error} end`,
      processedAt: sql`coalesce(${t.processedAt}, now())`,
      nextAttemptAt: null,
    })
    .where(and(eq(t.organizationId, organizationId), eq(t.kind, "message"), sql`(${sql.join(matches, sql` or `)})`))
    .returning({ id: t.id });
  return rows.length;
}
