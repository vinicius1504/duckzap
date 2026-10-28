import { webhookEventSchema, type CreatedWebhook, type CreateWebhookInput, type Webhook, type WebhookTestResult } from "@duckzap/contracts/settings";
import { schema, withOrg } from "@duckzap/db";
import { and, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { decryptSecret, encryptSecret, generateSecret, lastFour } from "../../lib/crypto";
import type { Deps } from "../../lib/context";
import { errRes, okRes, type Res } from "../team/result";
import { assertSafeUrl, safePost, UnsafeUrlError } from "./ssrf";
import { SIGNATURE_HEADER, signWebhookBody } from "./webhook-signature";

function toWebhook(row: typeof schema.webhookEndpoints.$inferSelect): Webhook {
  return {
    id: row.id,
    url: row.url,
    events: row.events.flatMap((e) => {
      const parsed = webhookEventSchema.safeParse(e);
      return parsed.success ? [parsed.data] : [];
    }),
    active: row.active,
    secretLast4: row.secretLast4,
    createdAt: row.createdAt.toISOString(),
    lastDelivery:
      row.lastDeliveryAt && row.lastDeliveryStatus !== null
        ? { at: row.lastDeliveryAt.toISOString(), statusCode: row.lastDeliveryStatus, ok: row.lastDeliveryOk ?? false }
        : null,
  };
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function listWebhooks(deps: Deps, organizationId: string): Promise<Webhook[]> {
  const rows = await withOrg(deps.db, organizationId, (tx) =>
    tx
      .select()
      .from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.organizationId, organizationId))
      .orderBy(desc(schema.webhookEndpoints.createdAt)),
  );
  return rows.map(toWebhook);
}

/** Cria o webhook. A URL passa pela proteção contra SSRF; o segredo de assinatura aparece só nesta resposta. */
export async function createWebhook(deps: Deps, organizationId: string, input: CreateWebhookInput): Promise<Res<CreatedWebhook>> {
  try {
    await assertSafeUrl(input.url);
  } catch (error) {
    if (error instanceof UnsafeUrlError) return errRes(422, "unsafe_url", error.message);
    throw error;
  }
  const signingSecret = generateSecret("whsec_");
  return withOrg(deps.db, organizationId, async (tx): Promise<Res<CreatedWebhook>> => {
    const [dup] = await tx
      .select({ id: schema.webhookEndpoints.id })
      .from(schema.webhookEndpoints)
      .where(and(eq(schema.webhookEndpoints.organizationId, organizationId), eq(schema.webhookEndpoints.url, input.url)));
    if (dup) return errRes(409, "duplicate", "Já existe um webhook para essa URL.");
    const [row] = await tx
      .insert(schema.webhookEndpoints)
      .values({
        id: uuidv7(),
        organizationId,
        url: input.url,
        events: input.events,
        secretEncrypted: encryptSecret(organizationId, signingSecret),
        secretLast4: lastFour(signingSecret),
      })
      .returning();
    if (!row) throw new Error("Falha ao criar o webhook");
    return okRes({ webhook: toWebhook(row), signingSecret });
  });
}

/** Envia um evento `ping` assinado (HMAC-SHA256) para a URL, com SSRF e limite de tempo. */
export async function testWebhook(deps: Deps, organizationId: string, id: string): Promise<Res<WebhookTestResult>> {
  if (!isUuid(id)) return errRes(404, "not_found", "Webhook não encontrado.");
  const [row] = await withOrg(deps.db, organizationId, (tx) =>
    tx
      .select()
      .from(schema.webhookEndpoints)
      .where(and(eq(schema.webhookEndpoints.organizationId, organizationId), eq(schema.webhookEndpoints.id, id))),
  );
  if (!row) return errRes(404, "not_found", "Webhook não encontrado.");

  const body = JSON.stringify({ id: uuidv7(), type: "ping", created_at: new Date().toISOString(), data: {} });
  const secret = decryptSecret(organizationId, row.secretEncrypted);
  const started = Date.now();
  let result: WebhookTestResult;
  try {
    const sent = await safePost(row.url, {
      body,
      headers: {
        "content-type": "application/json",
        "user-agent": "Duckzap-Webhooks/1.0",
        "x-duckzap-event": "ping",
        [SIGNATURE_HEADER.toLowerCase()]: signWebhookBody(secret, body),
      },
    });
    result = { ok: sent.statusCode >= 200 && sent.statusCode < 300, statusCode: sent.statusCode, durationMs: sent.durationMs };
  } catch {
    // bloqueado pelo SSRF, DNS, tempo esgotado ou conexão recusada: conta como falha (sem detalhe interno)
    result = { ok: false, statusCode: 0, durationMs: Date.now() - started };
  }
  await withOrg(deps.db, organizationId, (tx) =>
    tx
      .update(schema.webhookEndpoints)
      .set({ lastDeliveryAt: new Date(), lastDeliveryStatus: result.statusCode, lastDeliveryOk: result.ok })
      .where(and(eq(schema.webhookEndpoints.organizationId, organizationId), eq(schema.webhookEndpoints.id, id))),
  );
  return okRes(result);
}

export async function setWebhookActive(deps: Deps, organizationId: string, id: string, active: boolean): Promise<Res<null>> {
  if (!isUuid(id)) return errRes(404, "not_found", "Webhook não encontrado.");
  const rows = await withOrg(deps.db, organizationId, (tx) =>
    tx
      .update(schema.webhookEndpoints)
      .set({ active })
      .where(and(eq(schema.webhookEndpoints.organizationId, organizationId), eq(schema.webhookEndpoints.id, id)))
      .returning({ id: schema.webhookEndpoints.id }),
  );
  return rows.length ? okRes(null) : errRes(404, "not_found", "Webhook não encontrado.");
}

export async function deleteWebhook(deps: Deps, organizationId: string, id: string): Promise<Res<null>> {
  if (!isUuid(id)) return errRes(404, "not_found", "Webhook não encontrado.");
  const rows = await withOrg(deps.db, organizationId, (tx) =>
    tx
      .delete(schema.webhookEndpoints)
      .where(and(eq(schema.webhookEndpoints.organizationId, organizationId), eq(schema.webhookEndpoints.id, id)))
      .returning({ id: schema.webhookEndpoints.id }),
  );
  return rows.length ? okRes(null) : errRes(404, "not_found", "Webhook não encontrado.");
}
