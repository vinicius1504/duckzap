import { realtimeChannel, realtimeEnvelopeSchema } from "@duckzap/contracts/realtime";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeRealtime, publishRealtime, setRealtimePublisher } from "./realtime";

/**
 * INTEGRAÇÃO com o Valkey de verdade. Pula sozinho sem `REDIS_URL`.
 *   REDIS_URL=redis://:<senha>@127.0.0.1:6380 npx vitest run src/lib/realtime.valkey
 * Publica pelo caminho real (`publishRealtime` → um cliente ioredis compartilhado → PUBLISH) e confere, num assinante
 * separado, o que chega no canal de cada empresa: quem assina a empresa A nunca recebe nada da B.
 */
const url = process.env.REDIS_URL;

describe.skipIf(!url)("publicação real no Valkey", () => {
  const run = Math.random().toString(36).slice(2, 8);
  const orgA = `org_rt_${run}_a`;
  const orgB = `org_rt_${run}_b`;
  let subscriber: Redis;
  const received: Record<string, string[]> = { [orgA]: [], [orgB]: [] };

  beforeAll(async () => {
    setRealtimePublisher(null);
    subscriber = new Redis(url as string, { maxRetriesPerRequest: 2 });
    subscriber.on("message", (channel, payload) => {
      const org = channel === realtimeChannel(orgA) ? orgA : channel === realtimeChannel(orgB) ? orgB : null;
      if (org) received[org]?.push(payload);
    });
    // A assina SÓ o canal da empresa A (como o servidor de WebSocket faz por conexão)
    await subscriber.subscribe(realtimeChannel(orgA));
  });

  afterAll(async () => {
    await closeRealtime();
    subscriber?.disconnect();
  });

  it("o assinante da empresa A recebe o envelope da A, válido, sem nada além do contrato", async () => {
    publishRealtime(orgA, { type: "conversation.message", conversationId: "conv-1", direction: "in" });
    await expect.poll(() => received[orgA]?.length, { timeout: 5_000 }).toBe(1);
    const envelope = realtimeEnvelopeSchema.parse(JSON.parse(received[orgA]![0]!));
    expect(envelope).toMatchObject({ v: 1, organizationId: orgA, event: { type: "conversation.message", conversationId: "conv-1", direction: "in" } });
    expect(Object.keys(envelope).sort()).toEqual(["at", "event", "id", "organizationId", "v"]);
  });

  it("dois ambientes: o que a empresa B publica nunca chega a quem assina a A (e o canal da B só leva eventos da B)", async () => {
    const before = received[orgA]!.length;
    // uma terceira conexão assina a B só para provar que o publicador de fato escreveu lá
    const listenerB = new Redis(url as string, { maxRetriesPerRequest: 2 });
    const gotB: string[] = [];
    listenerB.on("message", (_channel, payload) => gotB.push(payload));
    await listenerB.subscribe(realtimeChannel(orgB));
    try {
      for (let i = 0; i < 5; i++) publishRealtime(orgB, { type: "home.invalidate" });
      publishRealtime(orgB, { type: "conversation.updated", conversationId: "conv-da-b", reason: "resolved" });
      await expect.poll(() => gotB.length, { timeout: 5_000 }).toBe(6);
      // dá uma folga para qualquer vazamento (que seria um bug) aparecer no assinante da A
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(received[orgA]!.length).toBe(before);
      expect(received[orgA]!.some((p) => p.includes("conv-da-b"))).toBe(false);
      for (const payload of gotB) expect(realtimeEnvelopeSchema.parse(JSON.parse(payload)).organizationId).toBe(orgB);
    } finally {
      listenerB.disconnect();
    }
  });

  it("ordem de publicação preservada para a mesma empresa e cada envelope tem id próprio", async () => {
    const start = received[orgA]!.length;
    for (let i = 0; i < 10; i++) publishRealtime(orgA, { type: "message.status", conversationId: "conv-ordem", messageId: `m${i}`, status: "sent" });
    await expect.poll(() => received[orgA]!.length - start, { timeout: 5_000 }).toBe(10);
    const slice = received[orgA]!.slice(start).map((p) => realtimeEnvelopeSchema.parse(JSON.parse(p)));
    expect(slice.map((e) => (e.event as { messageId: string }).messageId)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
    expect(new Set(slice.map((e) => e.id)).size).toBe(10);
  });
});
