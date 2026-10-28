import { createDb, schema, withOrg } from "@duckzap/db";
import { eq } from "drizzle-orm";
import { randomBytes, randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptSecret } from "../../lib/crypto";
import type { MessagingProvider, OutboundMessage } from "../../lib/messaging";
import { InMemoryTokenBucket } from "../channels/rate-limit";
import { loadChannelsConfig } from "../channels/config";
import { createChannelsRuntime, setChannelsRuntime } from "../channels/runtime";
import { loadConversationsConfig } from "./config";
import { handleMessage } from "./inbound";
import { deliverOutbound, NO_CHANNEL } from "./outbound";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";

/** Conversa sem canal (canal apagado) e mensagem por outro canal. Banco descartável; provedor falso. Usa uma empresa ATIVA própria (DATABASE_ADMIN_URL). */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const url = process.env.DATABASE_URL;
let ORG = "";
const run = Math.random().toString(36).slice(2, 8);

class Rollback extends Error {}

// `conversations.channel_id` é nullable (FK SET NULL) no schema atual: roda sempre que há banco (CONVERSATIONS_NULL_CHANNEL não é mais necessário)
describe.skipIf(!url || !process.env.DATABASE_ADMIN_URL)("Conversas — canal diferente e conversa sem canal", () => {
  const { db, close } = createDb(url ?? "postgres://invalid", { max: 3 });
  const sent: OutboundMessage[] = [];
  const provider: MessagingProvider = {
    kind: "evolution",
    capabilities: () => ({ buttons: false, lists: false, templates: false, media: true, reactions: false, window24h: false, presence: false }),
    connect: async () => ({ status: "connected" }),
    disconnect: async () => {},
    status: async () => "connected",
    send: async (_c, m) => {
      sent.push(m);
      return { ok: true, providerMessageId: `prov-${run}-${sent.length}` };
    },
    verifyWebhook: async () => true,
    parseWebhook: async () => [],
  };
  setChannelsRuntime(
    createChannelsRuntime({
      config: loadChannelsConfig({ CHANNELS_SEND_BURST_QR: "100", CHANNELS_SEND_PER_SECOND_QR: "100" }),
      providers: { get: () => provider, kinds: () => ["evolution"] },
      sendLimiterFor: () => new InMemoryTokenBucket({ capacity: 1000, refillPerSecond: 1000 }),
    }),
  );
  const inbound = {
    db,
    config: loadConversationsConfig({ CONVERSATIONS_BURST_WINDOW_MS: "0", CONVERSATIONS_BURST_MAX_WAIT_MS: "0" }),
    scheduleAiTurn: () => {},
    now: () => new Date(),
    log: { warn: () => {} },
  };
  const channels: string[] = [];
  let org: SecondOrg;
  beforeAll(async () => {
    org = await createSecondOrg("semcanal");
    ORG = org.orgId;
  });
  const phone = `+55679${randomInt(10_000_000, 99_999_999)}`;
  let seq = 0;

  async function channel(label: string, status = "connected") {
    const id = uuidv7();
    await withOrg(db, ORG, (tx) =>
      tx.insert(schema.channels).values({
        id,
        organizationId: ORG,
        name: `it-${run}-${label}`,
        type: "whatsapp_qr",
        provider: "evolution",
        status,
        webhookTokenHash: `h-${run}-${id}`,
        webhookTokenEnc: encryptSecret(ORG, "dzwh_x"),
      }),
    );
    channels.push(id);
    return id;
  }
  const receive = (channelId: string) =>
    handleMessage(
      inbound,
      { organizationId: ORG, channelId, event: { type: "message", externalId: `e-${run}-${seq}`, from: phone, kind: "text", text: "olá", at: new Date().toISOString() } },
      { type: "message", externalId: `e-${run}-${++seq}`, from: phone, kind: "text", text: "olá", at: new Date().toISOString() },
    );
  const convOf = (id: string) => withOrg(db, ORG, async (tx) => (await tx.select().from(schema.conversations).where(eq(schema.conversations.id, id)))[0]);

  afterAll(async () => {
    await org?.remove(); // cascata: canais, contatos, conversas e mensagens da empresa de teste
    await close();
  });

  it("mensagem por outro canal continua a MESMA conversa aberta; sem canal, adota o canal de entrada; envia pelo canal conectado", async () => {
    const a = await channel("a");
    const b = await channel("b");
    const first = await receive(a);
    expect(first.kind).toBe("stored");
    const convId = (first as { conversationId: string }).conversationId;

    const second = await receive(b);
    expect((second as { conversationId: string }).conversationId).toBe(convId); // mesma conversa, canal diferente
    expect((await convOf(convId))?.channelId).toBe(a);

    // canal da conversa apagado → conversa fica sem canal (FK SET NULL)
    await withOrg(db, ORG, (tx) => tx.update(schema.conversations).set({ channelId: null }).where(eq(schema.conversations.id, convId)));
    const third = await receive(b);
    expect((third as { conversationId: string }).conversationId).toBe(convId);
    expect((await convOf(convId))?.channelId).toBe(b); // adotou o canal por onde entrou

    // sem canal: envia pelo canal padrão conectado
    await withOrg(db, ORG, (tx) => tx.update(schema.conversations).set({ channelId: null }).where(eq(schema.conversations.id, convId)));
    const delivered = await withOrg(db, ORG, async (tx) => {
      const conv = (await tx.select().from(schema.conversations).where(eq(schema.conversations.id, convId)))[0]!;
      return deliverOutbound(tx, {
        conv,
        channelName: "x",
        to: phone,
        kind: "text",
        body: "resposta",
        media: null,
        sender: { kind: "member", id: "usr_marina", name: "Marina" },
        externalId: `out:${run}:1`,
        countsAsReply: true,
      });
    });
    expect(delivered.ok).toBe(true);
    // o canal padrão assina as mensagens de pessoa por padrão: "*Marina:*" (ou "*Marina (equipe):*") e o texto embaixo
    expect(sent.at(-1)).toMatchObject({ to: phone, text: expect.stringMatching(/^\*Marina( \([^)]*\))?:\*\nresposta$/) });
  });

  it("sem nenhum canal conectado, a mensagem fica `failed` com motivo claro (e não se perde)", async () => {
    await channel("c");
    const first = await receive(channels[0]!);
    const convId = (first as { conversationId: string }).conversationId;
    let result: Awaited<ReturnType<typeof deliverOutbound>> | undefined;
    let stored: { status: string | null; error: string | null } | undefined;
    await withOrg(db, ORG, async (tx) => {
      await tx.update(schema.channels).set({ status: "disconnected" }).where(eq(schema.channels.organizationId, ORG));
      await tx.update(schema.conversations).set({ channelId: null }).where(eq(schema.conversations.id, convId));
      const conv = (await tx.select().from(schema.conversations).where(eq(schema.conversations.id, convId)))[0]!;
      result = await deliverOutbound(tx, {
        conv,
        channelName: "x",
        to: phone,
        kind: "text",
        body: "sem canal",
        media: null,
        sender: { kind: "member", id: "usr_marina", name: "Marina" },
        externalId: `out:${run}:2`,
        countsAsReply: true,
      });
      const [m] = await tx.select().from(schema.messages).where(eq(schema.messages.id, result.message.id));
      stored = m;
      throw new Rollback(); // não deixa os canais da empresa desconectados
    }).catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
    expect(result?.ok).toBe(false);
    expect(stored).toMatchObject({ status: "failed", error: NO_CHANNEL });
  });
});
