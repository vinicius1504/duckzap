import { describe, expect, it } from "vitest";
import { RealtimeClient, type RealtimeNotice, type RealtimeStatus } from "./client";
import { FakeClock, FakePage, fakeSocketFactory } from "./fake";

const URL = "ws://localhost:4001/ws";
const at = "2026-01-01T12:00:00.000Z";
const ready = { type: "ready" };
const eventMsg = (id: string, event: object = { type: "home.invalidate" }) => ({ type: "event", id, at, event });

function setup(options: { hiddenPauseMs?: number; staleMs?: number; url?: string | (() => string | null) } = {}) {
  const clock = new FakeClock();
  const page = new FakePage();
  const net = fakeSocketFactory();
  const client = new RealtimeClient({
    url: options.url ?? URL,
    createSocket: net.factory,
    timers: clock,
    page,
    random: () => 1, // sem jitter: atrasos exatos (1 s, 2 s, 4 s…)
    ...(options.hiddenPauseMs !== undefined ? { hiddenPauseMs: options.hiddenPauseMs } : {}),
    ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}),
  });
  const notices: RealtimeNotice[] = [];
  const statuses: RealtimeStatus[] = [];
  let resyncs = 0;
  const fatals: Array<[string, number]> = [];
  client.subscribe((n) => notices.push(n));
  client.onStatus(() => statuses.push(client.getStatus()));
  client.onResync(() => resyncs++);
  client.onFatal((reason, code) => fatals.push([reason, code]));
  return { clock, page, net, client, notices, statuses, fatals, resyncs: () => resyncs };
}

describe("RealtimeClient: conexão", () => {
  it("abre, fica online no ready e entrega eventos validados sem repetir ids", () => {
    const t = setup();
    t.client.start();
    expect(t.net.sockets).toHaveLength(1);
    expect(t.net.last.url).toBe(URL);
    expect(t.client.getStatus()).toBe("connecting");
    t.net.last.open();
    t.net.last.receive(ready);
    expect(t.client.getStatus()).toBe("online");

    t.net.last.receive(eventMsg("e1"));
    t.net.last.receive(eventMsg("e1")); // repetido
    t.net.last.receive(eventMsg("e2", { type: "channel.status", channelId: "ch", status: "connected" }));
    expect(t.notices.map((n) => n.id)).toEqual(["e1", "e2"]);
    expect(t.notices[1]?.event).toEqual({ type: "channel.status", channelId: "ch", status: "connected" });
    expect(t.resyncs()).toBe(0); // conexão limpa: nada a recuperar
  });

  it("ignora mensagens inválidas sem derrubar a conexão", () => {
    const t = setup();
    t.client.start();
    t.net.last.receive(ready);
    t.net.last.receive("{quebrado");
    t.net.last.receive({ type: "event", id: "x", at: "ontem", event: { type: "home.invalidate" } });
    t.net.last.receive({ type: "event", id: "y", at, event: { type: "invented" } });
    expect(t.notices).toHaveLength(0);
    expect(t.client.getStatus()).toBe("online");
  });

  it("responde ping com pong", () => {
    const t = setup();
    t.client.start();
    t.net.last.receive(ready);
    t.net.last.receive({ type: "ping" });
    t.net.last.receive({ type: "ping" });
    expect(t.net.last.sent).toEqual(['{"type":"pong"}', '{"type":"pong"}']);
  });

  it("start duas vezes não abre dois sockets", () => {
    const t = setup();
    t.client.start();
    t.client.start();
    expect(t.net.sockets).toHaveLength(1);
  });

  it("sem URL (tempo real não configurado) fica offline e não abre nada", () => {
    const t = setup({ url: () => null });
    t.client.start();
    expect(t.net.sockets).toHaveLength(0);
    expect(t.client.getStatus()).toBe("offline");
  });

  it("fábrica que lança (CSP, URL ruim) vira nova tentativa, não exceção", () => {
    const clock = new FakeClock();
    let calls = 0;
    const client = new RealtimeClient({
      url: URL,
      createSocket: () => {
        calls++;
        throw new Error("blocked");
      },
      timers: clock,
      random: () => 1,
    });
    client.start();
    expect(calls).toBe(1);
    expect(client.getStatus()).toBe("offline");
    clock.advance(1000);
    expect(calls).toBe(2);
  });
});

describe("RealtimeClient: reconexão", () => {
  it("cai e reabre com backoff exponencial (1 s, 2 s, 4 s…) e zera depois do ready", () => {
    const t = setup();
    t.client.start();
    t.net.last.serverClose(1006);
    expect(t.client.getStatus()).toBe("offline");
    clock_advance(t, 999);
    expect(t.net.sockets).toHaveLength(1);
    clock_advance(t, 1);
    expect(t.net.sockets).toHaveLength(2);

    t.net.last.serverClose(1006); // 2ª queda sem ready: 2 s
    clock_advance(t, 1999);
    expect(t.net.sockets).toHaveLength(2);
    clock_advance(t, 1);
    expect(t.net.sockets).toHaveLength(3);

    t.net.last.receive(ready); // voltou: zera
    t.net.last.serverClose(1006);
    clock_advance(t, 1000);
    expect(t.net.sockets).toHaveLength(4);
  });

  it("o atraso não passa de 30 s", () => {
    const t = setup();
    t.client.start();
    for (let i = 0; i < 12; i++) {
      t.net.last.serverClose(1006);
      clock_advance(t, 30_000);
    }
    const before = t.net.sockets.length;
    t.net.last.serverClose(1006);
    clock_advance(t, 29_999);
    expect(t.net.sockets).toHaveLength(before);
    clock_advance(t, 1);
    expect(t.net.sockets).toHaveLength(before + 1);
  });

  it("4503 (servidor reiniciando) reconecta; ao voltar pede resync", () => {
    const t = setup();
    t.client.start();
    t.net.last.receive(ready);
    t.net.last.serverClose(4503);
    expect(t.fatals).toHaveLength(0);
    clock_advance(t, 1000);
    expect(t.net.sockets).toHaveLength(2);
    t.net.last.receive(ready);
    expect(t.resyncs()).toBe(1);
    t.net.last.serverClose(1006);
    clock_advance(t, 1000);
    t.net.last.receive(ready);
    expect(t.resyncs()).toBe(2);
  });

  it("4401, 4402 e 4403 param de vez: avisam o motivo e não reconectam", () => {
    for (const [code, reason] of [
      [4401, "unauthorized"],
      [4402, "suspended"],
      [4403, "forbidden_origin"],
    ] as const) {
      const t = setup();
      t.client.start();
      t.net.last.receive(ready);
      t.net.last.serverClose(code);
      expect(t.fatals).toEqual([[reason, code]]);
      expect(t.client.getFatal()).toBe(reason);
      expect(t.client.getStatus()).toBe("offline");
      clock_advance(t, 120_000);
      expect(t.net.sockets).toHaveLength(1);
      // nem voltar para a aba nem a rede religam
      t.page.emit("hidden");
      t.page.emit("visible");
      t.page.emit("online");
      expect(t.net.sockets).toHaveLength(1);
    }
  });

  it("rede voltou: reconecta já, sem esperar o backoff", () => {
    const t = setup();
    t.client.start();
    t.net.last.receive(ready);
    t.net.last.serverClose(1006);
    clock_advance(t, 1000);
    t.net.last.serverClose(1006); // espera 2 s agora
    expect(t.net.sockets).toHaveLength(2);
    t.page.emit("online");
    expect(t.net.sockets).toHaveLength(3);
    t.net.last.receive(ready);
    expect(t.resyncs()).toBe(1);
  });

  it("watchdog: sem nenhuma mensagem por 70 s derruba e reabre", () => {
    const t = setup();
    t.client.start();
    t.net.last.receive(ready);
    clock_advance(t, 60_000);
    t.net.last.receive({ type: "ping" }); // renova
    clock_advance(t, 69_999);
    expect(t.net.sockets).toHaveLength(1);
    clock_advance(t, 1);
    expect(t.net.sockets[0]?.closedWith).toBe(1000);
    expect(t.client.getStatus()).toBe("offline");
    clock_advance(t, 1000);
    expect(t.net.sockets).toHaveLength(2);
  });
});

describe("RealtimeClient: aba escondida", () => {
  it("escondida por muito tempo fecha a conexão; ao voltar reabre na hora e pede resync", () => {
    const t = setup({ hiddenPauseMs: 600_000 });
    t.client.start();
    t.net.last.receive(ready);
    t.page.emit("hidden");
    keepAlive(t, 599_999);
    expect(t.client.getStatus()).toBe("online");
    clock_advance(t, 1);
    expect(t.client.getStatus()).toBe("offline");
    expect(t.net.sockets[0]?.closedWith).toBe(1000);
    clock_advance(t, 3_600_000);
    expect(t.net.sockets).toHaveLength(1); // pausado: não tenta sozinho

    t.page.emit("visible");
    expect(t.net.sockets).toHaveLength(2);
    t.net.last.receive(ready);
    expect(t.resyncs()).toBe(1);
  });

  it("voltar a tempo cancela a pausa", () => {
    const t = setup({ hiddenPauseMs: 600_000 });
    t.client.start();
    t.net.last.receive(ready);
    t.page.emit("hidden");
    keepAlive(t, 300_000);
    t.page.emit("visible");
    keepAlive(t, 600_000);
    expect(t.client.getStatus()).toBe("online");
    expect(t.net.sockets).toHaveLength(1);
  });

  it("aba que volta durante uma espera de backoff reconecta imediatamente", () => {
    const t = setup();
    t.client.start();
    t.net.last.serverClose(1006);
    t.page.emit("hidden");
    t.page.emit("visible");
    expect(t.net.sockets).toHaveLength(2);
  });
});

describe("RealtimeClient: ciclo de vida", () => {
  it("stop fecha o socket, solta a página, cancela timers e ignora o que chegar depois", () => {
    const t = setup();
    t.client.start();
    const first = t.net.last;
    first.receive(ready);
    t.client.stop();
    expect(first.closedWith).toBe(1000);
    expect(t.client.getStatus()).toBe("offline");
    expect(t.page.listenerCount).toBe(0);
    expect(t.clock.pending).toBe(0);
    first.receive(eventMsg("tarde"));
    first.serverClose(1006);
    expect(t.notices).toHaveLength(0);
    clock_advance(t, 60_000);
    expect(t.net.sockets).toHaveLength(1);
  });

  it("StrictMode: start → stop → start deixa exatamente uma conexão viva", () => {
    const t = setup();
    t.client.start();
    t.client.stop();
    t.client.start();
    expect(t.net.sockets).toHaveLength(2);
    expect(t.net.sockets[0]?.closedWith).toBe(1000);
    expect(t.net.sockets[1]?.closedWith).toBeUndefined();
    expect(t.page.listenerCount).toBe(1);
    // o socket antigo não consegue mais influenciar o cliente
    t.net.sockets[0]?.receive(ready);
    expect(t.client.getStatus()).toBe("connecting");
    t.net.sockets[1]?.receive(ready);
    expect(t.client.getStatus()).toBe("online");
  });

  it("start depois de um erro fatal tenta de novo (nova montagem)", () => {
    const t = setup();
    t.client.start();
    t.net.last.serverClose(4401);
    t.client.stop();
    t.client.start();
    expect(t.net.sockets).toHaveLength(2);
    expect(t.client.getFatal()).toBeNull();
  });

  it("não vaza listeners: cancelar a inscrição para de entregar", () => {
    const t = setup();
    const got: string[] = [];
    const off = t.client.subscribe((n) => got.push(n.id));
    t.client.start();
    t.net.last.receive(eventMsg("a"));
    off();
    t.net.last.receive(eventMsg("b"));
    expect(got).toEqual(["a"]);
  });
});

function clock_advance(t: { clock: FakeClock }, ms: number) {
  t.clock.advance(ms);
}

/** Avança o relógio como numa conexão saudável: o servidor manda ping a cada 25 s. */
function keepAlive(t: { clock: FakeClock; net: { last: { receive(m: unknown): void } } }, ms: number) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(25_000, left);
    t.clock.advance(step);
    left -= step;
    if (left > 0) t.net.last.receive({ type: "ping" });
  }
}
