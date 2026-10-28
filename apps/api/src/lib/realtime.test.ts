import { realtimeEnvelopeSchema, realtimeEventSchema, type RealtimeEnvelope, type RealtimeEvent } from "@duckzap/contracts/realtime";
import type { Database, Transaction } from "@duckzap/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEnvelope,
  closeRealtime,
  flushRealtime,
  MAX_BULK_CONVERSATION_EVENTS,
  publishRealtime,
  queueConversationUpdates,
  queueRealtime,
  setRealtimePublisher,
  withOrgRealtime,
} from "./realtime";
import { loadRealtimeConfig } from "./realtime-config";

const ORG = "org_a";
const CONV = "0198f2c0-0000-7000-8000-000000000001";

/** Um exemplo válido de CADA tipo de evento do contrato. */
const examples: RealtimeEvent[] = [
  { type: "conversation.message", conversationId: CONV, direction: "in" },
  { type: "conversation.message", conversationId: CONV, direction: "out" },
  { type: "conversation.message", conversationId: CONV, direction: "internal" },
  ...(["assigned", "transferred", "mode", "resolved", "reopened", "stage", "read", "handoff", "queue", "follow_up", "other"] as const).map(
    (reason) => ({ type: "conversation.updated", conversationId: CONV, reason }) as RealtimeEvent,
  ),
  ...(["sending", "sent", "delivered", "read", "failed"] as const).map(
    (status) => ({ type: "message.status", conversationId: CONV, messageId: "msg-1", status }) as RealtimeEvent,
  ),
  { type: "channel.status", channelId: "chan-1", status: "qr_pending" },
  { type: "home.invalidate" },
  { type: "typing", conversationId: CONV, actor: "agent", active: true },
  { type: "typing", conversationId: CONV, actor: "contact", active: false },
];

describe("realtime-config", () => {
  it("sem REDIS_URL: desligado, com aviso (e sem lançar)", () => {
    expect(loadRealtimeConfig({})).toMatchObject({ redisUrl: null, warning: expect.stringContaining("REDIS_URL não definida") });
    expect(loadRealtimeConfig({ REDIS_URL: "   " }).redisUrl).toBeNull();
  });

  it("URL inválida desliga o recurso sem repetir o valor (pode ter senha)", () => {
    const result = loadRealtimeConfig({ REDIS_URL: "http://:segredo-de-teste@host:6379" });
    expect(result.redisUrl).toBeNull();
    expect(result.warning).not.toContain("segredo-de-teste");
    expect(loadRealtimeConfig({ REDIS_URL: "isso nao e url" }).redisUrl).toBeNull();
  });

  it("redis:// e rediss:// valem", () => {
    expect(loadRealtimeConfig({ REDIS_URL: "redis://:senha@127.0.0.1:6380" })).toEqual({ redisUrl: "redis://:senha@127.0.0.1:6380", warning: null });
    expect(loadRealtimeConfig({ REDIS_URL: "rediss://valkey.exemplo.com:6380" }).redisUrl).toBe("rediss://valkey.exemplo.com:6380");
  });
});

describe("envelope", () => {
  it.each(examples.map((e) => [JSON.stringify(e), e] as const))("evento do contrato vira envelope válido: %s", (_label, event) => {
    const envelope = buildEnvelope(ORG, event);
    expect(envelope).not.toBeNull();
    expect(realtimeEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(realtimeEventSchema.parse(envelope?.event)).toEqual(event);
    expect(envelope).toMatchObject({ v: 1, organizationId: ORG });
  });

  it("id é UUID v7 único e `at` é ISO-8601", () => {
    const a = buildEnvelope(ORG, { type: "home.invalidate" }, new Date("2026-05-01T12:00:00.000Z"));
    const b = buildEnvelope(ORG, { type: "home.invalidate" });
    expect(a?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a?.id).not.toBe(b?.id);
    expect(a?.at).toBe("2026-05-01T12:00:00.000Z");
  });

  it("descarta chaves fora do contrato (PII acidental): texto, nome e telefone nunca vão no envelope", () => {
    const leaky = {
      type: "conversation.message",
      conversationId: CONV,
      direction: "in",
      text: "Meu CPF é 123.456.789-00",
      body: "mensagem do cliente",
      contactName: "Maria da Silva",
      phone: "+5567999990000",
    } as unknown as RealtimeEvent;
    const envelope = buildEnvelope(ORG, leaky);
    const json = JSON.stringify(envelope);
    expect(envelope?.event).toEqual({ type: "conversation.message", conversationId: CONV, direction: "in" });
    for (const secret of ["CPF", "mensagem do cliente", "Maria", "+5567", "contactName", "phone"]) expect(json).not.toContain(secret);
  });

  it("evento fora do contrato é recusado", () => {
    expect(buildEnvelope(ORG, { type: "conversation.updated", conversationId: CONV, reason: "inventado" } as unknown as RealtimeEvent)).toBeNull();
    expect(buildEnvelope(ORG, { type: "nao.existe" } as unknown as RealtimeEvent)).toBeNull();
    expect(buildEnvelope(ORG, { type: "typing", conversationId: CONV, actor: "agent" } as unknown as RealtimeEvent)).toBeNull();
  });
});

describe("publishRealtime", () => {
  let warn: { mock: { calls: unknown[][] }; mockRestore(): void };
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    setRealtimePublisher(null);
    vi.unstubAllEnvs();
    warn.mockRestore();
    await closeRealtime();
  });

  it("entrega o envelope validado ao publicador", () => {
    const got: RealtimeEnvelope[] = [];
    setRealtimePublisher((envelope) => void got.push(envelope));
    publishRealtime(ORG, { type: "home.invalidate" });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ v: 1, organizationId: ORG, event: { type: "home.invalidate" } });
  });

  it("publicador que lança ou rejeita nunca derruba quem chamou", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      setRealtimePublisher(() => {
        throw new Error("explodiu");
      });
      expect(() => publishRealtime(ORG, { type: "home.invalidate" })).not.toThrow();
      setRealtimePublisher(async () => {
        throw new Error("rejeitou");
      });
      expect(() => publishRealtime(ORG, { type: "home.invalidate" })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("evento inválido não chega ao publicador", () => {
    const fake = vi.fn();
    setRealtimePublisher(fake);
    publishRealtime(ORG, { type: "conversation.updated", conversationId: CONV, reason: "x" } as unknown as RealtimeEvent);
    expect(fake).not.toHaveBeenCalled();
  });

  it("sem REDIS_URL: não faz nada e avisa UMA vez só", async () => {
    vi.stubEnv("REDIS_URL", "");
    for (let i = 0; i < 25; i++) expect(() => publishRealtime(ORG, { type: "home.invalidate" })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const mentions = warn.mock.calls.filter((entry) => String(entry[0]).includes("REDIS_URL"));
    expect(mentions).toHaveLength(1);
  });

  it("Valkey fora do ar: não lança, não espera e não deixa promessa rejeitada solta", async () => {
    // porta fechada: a conexão recusa; o ioredis tenta de novo com espera crescente
    vi.stubEnv("REDIS_URL", "redis://:senha-de-teste@127.0.0.1:1");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const started = Date.now();
      for (let i = 0; i < 500; i++) expect(() => publishRealtime(ORG, { type: "conversation.message", conversationId: CONV, direction: "in" })).not.toThrow();
      expect(Date.now() - started).toBeLessThan(500); // dispara e esquece (nada de await)
      await new Promise((resolve) => setTimeout(resolve, 1_800)); // dá tempo de o timeout/erro de comando acontecer
      expect(unhandled).not.toHaveBeenCalled();
      // nada do que foi logado contém a URL, a senha ou o conteúdo
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("senha-de-teste");
      expect(logged).not.toContain("redis://");
      const t0 = Date.now();
      await closeRealtime();
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

// ── eventos presos à transação ────────────────────────────────────────────────

/** `db` falso: só o que `withOrg` usa (`transaction` + `tx.execute`). */
function fakeDb() {
  const tx = { execute: async () => [] } as unknown as Transaction;
  const db = { transaction: async (fn: (t: Transaction) => Promise<unknown>) => fn(tx) } as unknown as Database;
  return { db, tx };
}

describe("eventos ligados à transação", () => {
  let got: RealtimeEnvelope[];
  beforeEach(() => {
    got = [];
    setRealtimePublisher((envelope) => void got.push(envelope));
  });
  afterEach(() => setRealtimePublisher(null));

  it("só publica depois que a transação termina (nunca de dentro dela)", async () => {
    const { db } = fakeDb();
    let insideCount = -1;
    const result = await withOrgRealtime(db, ORG, async (tx) => {
      queueRealtime(tx, ORG, { type: "conversation.message", conversationId: CONV, direction: "in" });
      insideCount = got.length;
      return "pronto";
    });
    expect(result).toBe("pronto");
    expect(insideCount).toBe(0);
    expect(got).toHaveLength(1);
  });

  it("transação que falha não publica nada", async () => {
    const { db } = fakeDb();
    await expect(
      withOrgRealtime(db, ORG, async (tx) => {
        queueRealtime(tx, ORG, { type: "home.invalidate" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(got).toEqual([]);
  });

  it("repetições idênticas na mesma transação viram um aviso só; diferentes continuam separados", async () => {
    const { db } = fakeDb();
    await withOrgRealtime(db, ORG, async (tx) => {
      for (let i = 0; i < 5; i++) queueRealtime(tx, ORG, { type: "conversation.message", conversationId: CONV, direction: "internal" });
      queueRealtime(tx, ORG, { type: "conversation.message", conversationId: CONV, direction: "out" });
      queueRealtime(tx, ORG, { type: "home.invalidate" });
      queueRealtime(tx, ORG, { type: "home.invalidate" });
    });
    expect(got.map((e) => e.event.type)).toEqual(["conversation.message", "conversation.message", "home.invalidate"]);
  });

  it("flush é de uma vez só (segunda chamada não republica)", () => {
    const { tx } = fakeDb();
    queueRealtime(tx, ORG, { type: "home.invalidate" });
    flushRealtime(tx);
    flushRealtime(tx);
    expect(got).toHaveLength(1);
  });

  it("ação em lote: um conversation.updated por conversa até o teto; acima, um único home.invalidate", () => {
    const { tx } = fakeDb();
    const some = Array.from({ length: 3 }, (_, i) => `conv-${i}`);
    queueConversationUpdates(tx, ORG, [...some, ...some], "resolved"); // repetidas contam uma vez
    flushRealtime(tx);
    expect(got.map((e) => e.event)).toEqual(some.map((conversationId) => ({ type: "conversation.updated", conversationId, reason: "resolved" })));

    got.length = 0;
    const many = Array.from({ length: MAX_BULK_CONVERSATION_EVENTS + 1 }, (_, i) => `conv-${i}`);
    queueConversationUpdates(tx, ORG, many, "resolved");
    flushRealtime(tx);
    expect(got.map((e) => e.event)).toEqual([{ type: "home.invalidate" }]);

    got.length = 0;
    queueConversationUpdates(tx, ORG, many.slice(0, MAX_BULK_CONVERSATION_EVENTS), "resolved");
    flushRealtime(tx);
    expect(got).toHaveLength(MAX_BULK_CONVERSATION_EVENTS);

    got.length = 0;
    queueConversationUpdates(tx, ORG, [], "resolved");
    flushRealtime(tx);
    expect(got).toEqual([]);
  });
});
