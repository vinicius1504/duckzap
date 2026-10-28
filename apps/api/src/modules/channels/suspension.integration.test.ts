import { createDb, schema, withOrg } from "@duckzap/db";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { processInbound, recordInbound } from "./inbound-store";
import { createChannelsRuntime } from "./runtime";
import { encryptSecret } from "../../lib/crypto";
import { sealCredentials } from "./repo";
import { suspendLapsedAccounts, suspendOrganization } from "./suspension";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";

try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const url = process.env.DATABASE_URL;
// Empresa de teste PRÓPRIA (criada no beforeAll): suspender desconecta TODOS os canais da empresa, então nunca pode ser a org_alvorada
// compartilhada com os outros arquivos de integração que rodam em paralelo.
let ORG = "";
const LAPSED = "org_lume"; // Básico com assinatura vencida (seed): conta suspensa
const run = Math.random().toString(36).slice(2, 8);

describe.skipIf(!url || !process.env.DATABASE_ADMIN_URL)("Conta suspensa — canais e webhooks", () => {
  const { db, close } = createDb(url ?? "postgres://invalid", { max: 3 });
  const disconnect = vi.fn(async () => {});
  const providers = { get: () => ({ disconnect }) } as never;
  const rt = createChannelsRuntime({ providers });
  const created: { org: string; id: string }[] = [];
  const orgs: SecondOrg[] = [];
  beforeAll(async () => {
    const active = await createSecondOrg("suspensao");
    orgs.push(active);
    ORG = active.orgId;
  });

  async function channel(org: string, type: "whatsapp_qr" | "whatsapp_official", provider: string, label: string) {
    const id = uuidv7();
    await withOrg(db, org, (tx) =>
      tx.insert(schema.channels).values({
        id,
        organizationId: org,
        name: `it-${run}-${label}`,
        type,
        provider,
        status: "connected",
        webhookTokenHash: `hash-${run}-${id}`,
        webhookTokenEnc: encryptSecret(org, "dzwh_teste"),
        credentialsEnc: sealCredentials(org, { instanceToken: "TOKEN-INSTANCIA", accessToken: "TOKEN-META" } as never),
      }),
    );
    created.push({ org, id });
    return id;
  }
  const statusOf = (org: string, id: string) => withOrg(db, org, async (tx) => (await tx.select().from(schema.channels).where(eq(schema.channels.id, id)))[0]);

  afterAll(async () => {
    for (const c of created) await withOrg(db, c.org, (tx) => tx.delete(schema.channels).where(eq(schema.channels.id, c.id)));
    for (const o of orgs) await o.remove();
    await close();
  });

  it("QR: desloga no provedor e marca desconectado; Meta: só marca, credenciais intactas; segunda rodada não repete", async () => {
    const qr = await channel(ORG, "whatsapp_qr", "evolution", "qr");
    const meta = await channel(ORG, "whatsapp_official", "meta_cloud", "meta");
    const first = await suspendOrganization(db, rt, ORG);
    expect(first.disconnected).toBeGreaterThanOrEqual(2);
    expect(disconnect).toHaveBeenCalled(); // só canais QR chamam o provedor (a Meta não)
    const rowQr = await statusOf(ORG, qr);
    const rowMeta = await statusOf(ORG, meta);
    expect(rowQr?.status).toBe("disconnected");
    expect(rowMeta?.status).toBe("disconnected");
    expect(rowMeta?.credentialsEnc).not.toBeNull();
    const again = await suspendOrganization(db, rt, ORG);
    expect(again.disconnected).toBe(0);
  });

  it("falha do provedor não impede de marcar desconectado (e preserva as credenciais)", async () => {
    const failing = vi.fn(async () => {
      throw new Error("evolution fora");
    });
    const rt2 = createChannelsRuntime({ providers: { get: () => ({ disconnect: failing }) } as never });
    const qr = await channel(ORG, "whatsapp_qr", "evolution", "qr-falha");
    const result = await suspendOrganization(db, rt2, ORG);
    expect(result.providerFailures).toBeGreaterThanOrEqual(1);
    const row = await statusOf(ORG, qr);
    expect(row?.status).toBe("disconnected");
    expect(row?.credentialsEnc).not.toBeNull();
  });

  it("o job varre só contas suspensas: vencida (expired) é desconectada; ativa e em tolerância (past_due) continuam conectadas", async () => {
    const lapsed = await createSecondOrg("vencida", { status: "expired", daysToEnd: -5 });
    const grace = await createSecondOrg("tolerancia", { daysToEnd: -1 });
    const active = await createSecondOrg("ativa");
    orgs.push(lapsed, grace, active);
    const lapsedChannel = await channel(lapsed.orgId, "whatsapp_qr", "evolution", "job-vencida");
    const graceChannel = await channel(grace.orgId, "whatsapp_official", "meta_cloud", "job-tolerancia");
    const activeChannel = await channel(active.orgId, "whatsapp_qr", "evolution", "job-ativa");
    const result = await suspendLapsedAccounts(db, rt, { limit: 500 });
    expect(result.organizations).toBeGreaterThanOrEqual(1);
    expect((await statusOf(lapsed.orgId, lapsedChannel))?.status).toBe("disconnected");
    expect((await statusOf(grace.orgId, graceChannel))?.status).toBe("connected");
    expect((await statusOf(active.orgId, activeChannel))?.status).toBe("connected");
    // empresa desativada pelo admin (disabled_at) também é suspensa, mesmo com vencimento no futuro
    const disabled = await createSecondOrg("desativada");
    orgs.push(disabled);
    const disabledChannel = await channel(disabled.orgId, "whatsapp_official", "meta_cloud", "job-desativada");
    const owner = createDb(process.env.DATABASE_ADMIN_URL as string, { max: 1 });
    try {
      await owner.db.update(schema.subscriptions).set({ disabledAt: new Date() }).where(eq(schema.subscriptions.organizationId, disabled.orgId));
    } finally {
      await owner.close();
    }
    await suspendLapsedAccounts(db, rt, { limit: 500 });
    expect((await statusOf(disabled.orgId, disabledChannel))?.status).toBe("disconnected");
  });

  it("evento de mensagem de empresa suspensa é gravado mas NÃO processado", async () => {
    const id = await channel(LAPSED, "whatsapp_official", "meta_cloud", "lume");
    const handled = vi.fn();
    const { registerInboundHandler } = await import("../../lib/inbound");
    registerInboundHandler(async (ctx) => {
      if (ctx.channelId === id) handled();
    });
    const event = { type: "message" as const, externalId: `susp-${run}`, from: "+5567911112222", kind: "text" as const, text: "oi", at: "2026-10-26T12:00:00.000Z" };
    const { ids } = await recordInbound(db, { organizationId: LAPSED, channelId: id, rawBody: "{}", events: [event], parseFailed: false });
    expect(ids).toHaveLength(1);
    const result = await processInbound(db, LAPSED, rt, { ids });
    expect(result.processed).toBe(0);
    expect(handled).not.toHaveBeenCalled();
    const [row] = await withOrg(db, LAPSED, (tx) => tx.select().from(schema.inboundEvents).where(eq(schema.inboundEvents.channelId, id)));
    expect(row?.processedAt).toBeNull();
    expect(row?.attempts).toBe(0);
  });
});
