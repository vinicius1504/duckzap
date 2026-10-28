import { EventEmitter } from "node:events";
import { realtimeChannel, type RealtimeEnvelope } from "@duckzap/contracts/realtime";
import { WebSocket } from "ws";
import { parseConfig, type RealtimeConfig } from "../src/config";
import { createRealtimeServer, type RealtimeServer, type Subscriber } from "../src/server";
import type { SessionCheck } from "../src/session";

export const WEB_ORIGIN = "http://localhost:3000";

export class FakeSubscriber extends EventEmitter implements Subscriber {
  readonly calls: Array<{ op: "subscribe" | "unsubscribe"; channel: string }> = [];
  readonly active = new Set<string>();
  quitCalled = false;
  failSubscribe = false;

  subscribe(channel: string): Promise<unknown> {
    this.calls.push({ op: "subscribe", channel });
    if (this.failSubscribe) return Promise.reject(new Error("boom"));
    this.active.add(channel);
    return Promise.resolve(1);
  }
  unsubscribe(channel: string): Promise<unknown> {
    this.calls.push({ op: "unsubscribe", channel });
    this.active.delete(channel);
    return Promise.resolve(0);
  }
  quit(): Promise<unknown> {
    this.quitCalled = true;
    return Promise.resolve("OK");
  }
  /** Simula uma mensagem chegando do Valkey em `channel` (só entrega se o canal estiver assinado, como o Valkey faria). */
  publish(channel: string, message: string) {
    if (this.active.has(channel)) this.emit("message", channel, message);
  }
  /** Entrega mesmo sem assinatura, para testar que o servidor ignora canal que não assinou. */
  publishRaw(channel: string, message: string) {
    this.emit("message", channel, message);
  }
}

export function makeConfig(overrides: Partial<RealtimeConfig> = {}): RealtimeConfig {
  return {
    ...parseConfig({ REDIS_URL: "redis://127.0.0.1:6380", WEB_ORIGINS: WEB_ORIGIN, REALTIME_HOST: "127.0.0.1" }),
    // timers reais ficam longe; os testes chamam runHeartbeat/runRevalidation à mão
    pingIntervalMs: 3_600_000,
    pongTimeoutMs: 7_200_000,
    revalidateIntervalMs: 86_400_000,
    ...overrides,
  };
}

export const envelope = (organizationId: string, id: string, event: RealtimeEnvelope["event"] = { type: "home.invalidate" }): RealtimeEnvelope => ({
  v: 1,
  id,
  organizationId,
  at: new Date().toISOString(),
  event,
});

export interface Harness {
  server: RealtimeServer;
  subscriber: FakeSubscriber;
  port: number;
  sessions: Map<string, SessionCheck>;
  validateCalls: string[];
  clock: { t: number };
  clients: TestClient[];
  connect(opts?: ConnectOptions): Promise<TestClient>;
  /** Publica no canal de `channelOrg` o envelope (que pode, de propósito, declarar outra empresa). */
  publish(channelOrg: string, env: RealtimeEnvelope): void;
  stop(): Promise<void>;
}

export interface ConnectOptions {
  cookie?: string | null;
  origin?: string | null;
}

export class TestClient {
  readonly messages: Array<Record<string, unknown>> = [];
  closeCode: number | undefined;
  closed = false;
  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => this.messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    ws.on("close", (code) => {
      this.closed = true;
      this.closeCode = code;
    });
    ws.on("error", () => undefined);
  }
  events() {
    return this.messages.filter((m) => m.type === "event");
  }
  eventIds() {
    return this.events().map((m) => m.id);
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000, what = "condição") {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout esperando ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function startHarness(options: { config?: Partial<RealtimeConfig>; sessions?: Record<string, SessionCheck> } = {}): Promise<Harness> {
  const subscriber = new FakeSubscriber();
  const sessions = new Map<string, SessionCheck>(Object.entries(options.sessions ?? {}));
  const validateCalls: string[] = [];
  const clock = { t: 1_000_000 };
  const server = createRealtimeServer({
    config: makeConfig(options.config),
    subscriber,
    validateSession: (cookie) => {
      validateCalls.push(cookie);
      return Promise.resolve(sessions.get(cookie) ?? { kind: "unauthorized" });
    },
    now: () => clock.t,
    log: () => undefined,
  });
  const port = await server.listen(0);
  const clients: TestClient[] = [];

  const harness: Harness = {
    server,
    subscriber,
    port,
    sessions,
    validateCalls,
    clock,
    clients,
    async connect(opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.origin !== null) headers.origin = opts.origin ?? WEB_ORIGIN;
      if (opts.cookie !== null) headers.cookie = opts.cookie ?? "sid=a";
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
      const client = new TestClient(ws);
      clients.push(client);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("unexpected-response", (_req, res) => {
          res.resume();
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        });
        ws.once("error", reject);
      });
      return client;
    },
    publish(channelOrg, env) {
      subscriber.publish(realtimeChannel(channelOrg), JSON.stringify(env));
    },
    async stop() {
      for (const client of clients) client.ws.terminate();
      await server.close();
    },
  };
  return harness;
}

/** Tenta conectar e devolve o status HTTP da recusa (ou "open"). */
export async function connectStatus(h: Harness, opts: ConnectOptions): Promise<number | "open"> {
  try {
    const client = await h.connect(opts);
    client.ws.terminate();
    return "open";
  } catch (error) {
    return (error as { status?: number }).status ?? 0;
  }
}
