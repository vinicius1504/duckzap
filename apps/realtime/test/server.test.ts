import { realtimeChannel, serverMessageSchema } from "@duckzap/contracts/realtime";
import { afterEach, describe, expect, it } from "vitest";
import { connectStatus, envelope, startHarness, waitFor, type Harness } from "./helpers";

const ORG_A = "org-a";
const ORG_B = "org-b";
const sessions = {
  "sid=a": { kind: "ok", organizationId: ORG_A, userId: "user-a1" },
  "sid=a2": { kind: "ok", organizationId: ORG_A, userId: "user-a2" },
  "sid=b": { kind: "ok", organizationId: ORG_B, userId: "user-b1" },
  "sid=suspended": { kind: "suspended" },
  "sid=down": { kind: "unavailable" },
} as const;

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

async function readyClient(harness: Harness, cookie: string) {
  const client = await harness.connect({ cookie });
  await waitFor(() => client.messages.some((m) => m.type === "ready"), 3000, "ready");
  return client;
}

describe("origem", () => {
  it("recusa com 403 origem desconhecida ou ausente, sem sequer consultar a API", async () => {
    h = await startHarness({ sessions });
    expect(await connectStatus(h, { origin: "https://evil.example" })).toBe(403);
    expect(await connectStatus(h, { origin: "http://localhost:3000.evil.example" })).toBe(403);
    expect(await connectStatus(h, { origin: null })).toBe(403);
    expect(h.validateCalls).toHaveLength(0);
    expect(h.subscriber.calls).toHaveLength(0);
  });

  it("aceita a origem configurada e responde ready", async () => {
    h = await startHarness({ sessions });
    const client = await readyClient(h, "sid=a");
    expect(client.messages[0]).toEqual({ type: "ready" });
  });

  it("só atende em /ws e /health", async () => {
    h = await startHarness({ sessions });
    const health = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", redis: "up", connections: 0 });
    expect((await fetch(`http://127.0.0.1:${h.port}/outra`)).status).toBe(404);
  });
});

describe("autenticação", () => {
  it("sessão inválida: abre e fecha com 4401, sem assinar nada", async () => {
    h = await startHarness({ sessions });
    const client = await h.connect({ cookie: "sid=expirada" });
    await waitFor(() => client.closed);
    expect(client.closeCode).toBe(4401);
    expect(client.messages).toHaveLength(0);
    expect(h.subscriber.calls).toHaveLength(0);
  });

  it("sem cookie: 4401", async () => {
    h = await startHarness({ sessions });
    const client = await h.connect({ cookie: null });
    await waitFor(() => client.closed);
    expect(client.closeCode).toBe(4401);
  });

  it("conta suspensa: 4402, sem assinar nada", async () => {
    h = await startHarness({ sessions });
    const client = await h.connect({ cookie: "sid=suspended" });
    await waitFor(() => client.closed);
    expect(client.closeCode).toBe(4402);
    expect(h.subscriber.calls).toHaveLength(0);
  });

  it("API fora do ar: recusa com 503 (o cliente tenta de novo)", async () => {
    h = await startHarness({ sessions });
    expect(await connectStatus(h, { cookie: "sid=down" })).toBe(503);
    expect(h.subscriber.calls).toHaveLength(0);
  });

  it("encaminha o cookie do navegador à API", async () => {
    h = await startHarness({ sessions });
    await readyClient(h, "sid=a");
    expect(h.validateCalls).toEqual(["sid=a"]);
  });
});

describe("isolamento entre empresas (propriedade crítica)", () => {
  it("o socket da empresa A nunca recebe eventos da empresa B (e vice-versa)", async () => {
    h = await startHarness({ sessions });
    const a = await readyClient(h, "sid=a");
    const a2 = await readyClient(h, "sid=a2");
    const b = await readyClient(h, "sid=b");

    h.publish(ORG_A, envelope(ORG_A, "evt-a-1", { type: "conversation.message", conversationId: "c1", direction: "in" }));
    h.publish(ORG_B, envelope(ORG_B, "evt-b-1", { type: "conversation.message", conversationId: "c2", direction: "in" }));
    h.publish(ORG_A, envelope(ORG_A, "evt-a-2"));

    await waitFor(() => a.events().length === 2 && a2.events().length === 2 && b.events().length === 1);
    expect(a.eventIds()).toEqual(["evt-a-1", "evt-a-2"]);
    expect(a2.eventIds()).toEqual(["evt-a-1", "evt-a-2"]);
    expect(b.eventIds()).toEqual(["evt-b-1"]);
  });

  it("envelope forjado (organizationId diferente do canal em que chegou) é descartado para todos", async () => {
    h = await startHarness({ sessions });
    const a = await readyClient(h, "sid=a");
    const b = await readyClient(h, "sid=b");

    // chegou no canal da A, mas diz ser da B; e o inverso
    h.publish(ORG_A, envelope(ORG_B, "forged-1"));
    h.publish(ORG_B, envelope(ORG_A, "forged-2"));
    // sentinelas legítimas: como a entrega é em ordem, quando chegarem os forjados já teriam chegado
    h.publish(ORG_A, envelope(ORG_A, "ok-a"));
    h.publish(ORG_B, envelope(ORG_B, "ok-b"));

    await waitFor(() => a.events().length === 1 && b.events().length === 1);
    expect(a.eventIds()).toEqual(["ok-a"]);
    expect(b.eventIds()).toEqual(["ok-b"]);
    expect(h.server.stats().droppedForged).toBe(2);
  });

  it("canal de empresa sem conexões, ou fora do prefixo, é ignorado", async () => {
    h = await startHarness({ sessions });
    const a = await readyClient(h, "sid=a");
    h.subscriber.publishRaw(realtimeChannel(ORG_B), JSON.stringify(envelope(ORG_B, "sem-ouvintes")));
    h.subscriber.publishRaw("outro:canal", JSON.stringify(envelope(ORG_A, "canal-estranho")));
    h.subscriber.publishRaw(`${realtimeChannel(ORG_A)}:extra`, JSON.stringify(envelope(ORG_A, "canal-extra")));
    h.publish(ORG_A, envelope(ORG_A, "ok"));
    await waitFor(() => a.events().length === 1);
    expect(a.eventIds()).toEqual(["ok"]);
  });

  it("descarta mensagens inválidas sem derrubar ninguém e só repassa campos do contrato", async () => {
    h = await startHarness({ sessions });
    const a = await readyClient(h, "sid=a");
    const channel = realtimeChannel(ORG_A);

    h.subscriber.publish(channel, "isto não é json");
    h.subscriber.publish(channel, JSON.stringify({ v: 2, id: "x", organizationId: ORG_A, at: new Date().toISOString(), event: { type: "home.invalidate" } }));
    h.subscriber.publish(channel, JSON.stringify({ v: 1, id: "y", organizationId: ORG_A, at: "ontem", event: { type: "home.invalidate" } }));
    h.subscriber.publish(channel, JSON.stringify({ v: 1, id: "z", organizationId: ORG_A, at: new Date().toISOString(), event: { type: "desconhecido" } }));
    h.subscriber.publish(channel, "x".repeat(40_000));
    // campos extras (ex.: texto de mensagem que nunca deveria estar ali) não atravessam
    h.subscriber.publish(
      channel,
      JSON.stringify({
        ...envelope(ORG_A, "com-extra", { type: "conversation.message", conversationId: "c1", direction: "in" }),
        organizationSecret: "nao-deve-sair",
        event: { type: "conversation.message", conversationId: "c1", direction: "in", text: "conteudo-sensivel" },
      }),
    );

    await waitFor(() => a.events().length === 1);
    expect(a.closed).toBe(false);
    const frame = a.events()[0];
    expect(serverMessageSchema.safeParse(frame).success).toBe(true);
    expect(JSON.stringify(frame)).not.toContain("conteudo-sensivel");
    expect(JSON.stringify(frame)).not.toContain("nao-deve-sair");
    expect(JSON.stringify(frame)).not.toContain(ORG_A);
    expect(h.server.stats().droppedInvalid).toBe(5);
  });
});

describe("assinatura preguiçosa", () => {
  it("assina na primeira conexão da empresa e cancela quando a última sai", async () => {
    h = await startHarness({ sessions });
    expect(h.subscriber.calls).toHaveLength(0);

    const a1 = await readyClient(h, "sid=a");
    const a2 = await readyClient(h, "sid=a2");
    expect(h.subscriber.calls).toEqual([{ op: "subscribe", channel: realtimeChannel(ORG_A) }]);

    const b = await readyClient(h, "sid=b");
    expect(h.subscriber.calls.filter((c) => c.op === "subscribe").map((c) => c.channel)).toEqual([realtimeChannel(ORG_A), realtimeChannel(ORG_B)]);
    expect(h.server.stats().subscribedChannels).toBe(2);

    a1.ws.close();
    await waitFor(() => h!.server.stats().connections === 2);
    expect(h.subscriber.calls.some((c) => c.op === "unsubscribe")).toBe(false);

    a2.ws.close();
    await waitFor(() => h!.subscriber.calls.some((c) => c.op === "unsubscribe" && c.channel === realtimeChannel(ORG_A)));
    expect(h.subscriber.active.has(realtimeChannel(ORG_A))).toBe(false);
    expect(h.subscriber.active.has(realtimeChannel(ORG_B))).toBe(true);

    b.ws.close();
    await waitFor(() => h!.server.stats().subscribedChannels === 0);
    expect(h.server.stats().organizations).toBe(0);
  });

  it("reabrir depois de esvaziar assina de novo", async () => {
    h = await startHarness({ sessions });
    const first = await readyClient(h, "sid=a");
    first.ws.close();
    await waitFor(() => h!.server.stats().subscribedChannels === 0);
    const second = await readyClient(h, "sid=a");
    h.publish(ORG_A, envelope(ORG_A, "depois"));
    await waitFor(() => second.events().length === 1);
  });

  it("falha ao assinar: fecha a conexão (cliente tenta de novo) em vez de ficar surdo", async () => {
    h = await startHarness({ sessions });
    h.subscriber.failSubscribe = true;
    const client = await h.connect({ cookie: "sid=a" });
    await waitFor(() => client.closed);
    expect(client.closeCode).toBe(1013);
    expect(client.messages.some((m) => m.type === "ready")).toBe(false);
  });
});

describe("heartbeat", () => {
  it("manda ping e derruba quem não responde pong em 60 s", async () => {
    h = await startHarness({ sessions, config: { pongTimeoutMs: 60_000 } });
    const silent = await readyClient(h, "sid=a");
    const alive = await readyClient(h, "sid=a2");

    h.server.runHeartbeat();
    await waitFor(() => silent.messages.some((m) => m.type === "ping") && alive.messages.some((m) => m.type === "ping"));

    h.clock.t += 30_000;
    alive.ws.send(JSON.stringify({ type: "pong" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.clock.t += 31_000; // 61 s desde a conexão do silent; 31 s desde o pong do alive
    h.server.runHeartbeat();

    await waitFor(() => silent.closed);
    expect(alive.closed).toBe(false);
    await waitFor(() => h!.server.stats().connections === 1);
  });
});

describe("limites", () => {
  it("limita conexões por usuário (429) e libera vaga quando uma fecha", async () => {
    h = await startHarness({ sessions, config: { maxConnectionsPerUser: 2 } });
    const c1 = await readyClient(h, "sid=a");
    await readyClient(h, "sid=a");
    expect(await connectStatus(h, { cookie: "sid=a" })).toBe(429);
    // outro usuário da mesma empresa não é afetado
    await readyClient(h, "sid=a2");
    c1.ws.close();
    await waitFor(() => c1.closed);
    await expect.poll(() => connectStatus(h!, { cookie: "sid=a" }), { timeout: 3000 }).toBe("open");
  });

  it("limita conexões por IP (429)", async () => {
    h = await startHarness({ sessions, config: { maxConnectionsPerIp: 2 } });
    await readyClient(h, "sid=a");
    await readyClient(h, "sid=b");
    expect(await connectStatus(h, { cookie: "sid=a2" })).toBe(429);
  });

  it("mensagem do cliente fora do contrato fecha a conexão (1008)", async () => {
    h = await startHarness({ sessions });
    for (const payload of ["isto não é json", JSON.stringify({ type: "subscribe", orgId: ORG_B }), JSON.stringify({ type: "PONG" }), "[]", "null"]) {
      const client = await readyClient(h, "sid=a");
      client.ws.send(payload);
      await waitFor(() => client.closed);
      expect(client.closeCode).toBe(1008);
    }
  });

  it("mensagem binária fecha com 1003 e pong válido é aceito", async () => {
    h = await startHarness({ sessions });
    const ok = await readyClient(h, "sid=a");
    ok.ws.send(JSON.stringify({ type: "pong" }));
    const bin = await readyClient(h, "sid=a2");
    bin.ws.send(Buffer.from([1, 2, 3]));
    await waitFor(() => bin.closed);
    expect(bin.closeCode).toBe(1003);
    expect(ok.closed).toBe(false);
  });

  it("mensagem maior que o limite fecha com 1009", async () => {
    h = await startHarness({ sessions, config: { maxMessageBytes: 1024 } });
    const client = await readyClient(h, "sid=a");
    client.ws.send("x".repeat(2000));
    await waitFor(() => client.closed);
    expect(client.closeCode).toBe(1009);
  });

  it("excesso de mensagens por janela fecha com 1008", async () => {
    h = await startHarness({ sessions, config: { clientMessagesPer10s: 3 } });
    const client = await readyClient(h, "sid=a");
    for (let i = 0; i < 4; i += 1) client.ws.send(JSON.stringify({ type: "pong" }));
    await waitFor(() => client.closed);
    expect(client.closeCode).toBe(1008);
  });
});

describe("revalidação periódica", () => {
  it("fecha com 4401 quem teve a sessão revogada e 4402 quem foi suspenso; mantém o resto", async () => {
    h = await startHarness({ sessions });
    const revoked = await readyClient(h, "sid=a");
    const suspendedLater = await readyClient(h, "sid=a2");
    const fine = await readyClient(h, "sid=b");

    h.sessions.delete("sid=a");
    h.sessions.set("sid=a2", { kind: "suspended" });
    await h.server.runRevalidation();

    await waitFor(() => revoked.closed && suspendedLater.closed);
    expect(revoked.closeCode).toBe(4401);
    expect(suspendedLater.closeCode).toBe(4402);
    expect(fine.closed).toBe(false);
  });

  it("API indisponível na revalidação não derruba ninguém", async () => {
    h = await startHarness({ sessions });
    const client = await readyClient(h, "sid=a");
    h.sessions.set("sid=a", { kind: "unavailable" });
    await h.server.runRevalidation();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.closed).toBe(false);
  });

  it("troca de empresa na sessão fecha com 4401 (reconecta na empresa certa)", async () => {
    h = await startHarness({ sessions });
    const client = await readyClient(h, "sid=a");
    h.sessions.set("sid=a", { kind: "ok", organizationId: ORG_B, userId: "user-a1" });
    await h.server.runRevalidation();
    await waitFor(() => client.closed);
    expect(client.closeCode).toBe(4401);
  });
});

describe("desligamento", () => {
  it("fecha os sockets com 4503 e encerra o subscriber", async () => {
    h = await startHarness({ sessions });
    const client = await readyClient(h, "sid=a");
    await h.server.close();
    expect(client.closeCode).toBe(4503);
    expect(h.subscriber.quitCalled).toBe(true);
  });
});
