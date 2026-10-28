import { randomUUID } from "node:crypto";
import { realtimeChannel } from "@duckzap/contracts/realtime";
import { Redis } from "ioredis";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealtimeServer } from "../src/server";
import { envelope, makeConfig, WEB_ORIGIN, waitFor } from "./helpers";

const REDIS_URL = process.env.REDIS_URL;

// Integração com o Valkey REAL (docker local). Pulado se REDIS_URL não estiver definida.
describe.skipIf(!REDIS_URL)("integração com Valkey real", () => {
  const orgA = `it-${randomUUID()}`;
  const orgB = `it-${randomUUID()}`;
  const subscriber = new Redis(REDIS_URL ?? "redis://127.0.0.1:6380", { autoResubscribe: true, enableReadyCheck: false, maxRetriesPerRequest: null });
  const publisher = new Redis(REDIS_URL ?? "redis://127.0.0.1:6380");
  const server = createRealtimeServer({
    config: makeConfig(),
    subscriber,
    validateSession: (cookie) =>
      Promise.resolve(
        cookie === "sid=a" ? { kind: "ok", organizationId: orgA, userId: "ua" } : cookie === "sid=b" ? { kind: "ok", organizationId: orgB, userId: "ub" } : { kind: "unauthorized" },
      ),
    log: () => undefined,
  });

  let port = 0;
  beforeAll(async () => {
    port = await server.listen(0);
  });

  afterAll(async () => {
    await server.close();
    await publisher.quit();
  });

  const open = async (port: number, cookie: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: WEB_ORIGIN, cookie } });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    await waitFor(() => messages.some((m) => m.type === "ready"), 5000, "ready");
    return { ws, messages };
  };

  it("entrega o que a API publica no canal da empresa, só a quem é dela, e cancela a assinatura ao esvaziar", async () => {
    const a = await open(port, "sid=a");
    const b = await open(port, "sid=b");

    // o Valkey enxerga a assinatura criada sob demanda
    const subs = await publisher.pubsub("CHANNELS", "rt:org:it-*");
    expect(subs).toEqual(expect.arrayContaining([realtimeChannel(orgA), realtimeChannel(orgB)]));

    const receivers = await publisher.publish(realtimeChannel(orgA), JSON.stringify(envelope(orgA, "real-a", { type: "conversation.updated", conversationId: "c1", reason: "assigned" })));
    expect(receivers).toBe(1);
    // forjado: anuncia a empresa B dentro do canal da A
    await publisher.publish(realtimeChannel(orgA), JSON.stringify(envelope(orgB, "real-forjado")));
    await publisher.publish(realtimeChannel(orgB), JSON.stringify(envelope(orgB, "real-b")));

    await waitFor(() => a.messages.some((m) => m.id === "real-a") && b.messages.some((m) => m.id === "real-b"), 5000, "eventos");
    expect(a.messages.find((m) => m.id === "real-a")).toMatchObject({ type: "event", event: { type: "conversation.updated", conversationId: "c1", reason: "assigned" } });
    expect(a.messages.some((m) => m.id === "real-b" || m.id === "real-forjado")).toBe(false);
    expect(b.messages.some((m) => m.id === "real-a" || m.id === "real-forjado")).toBe(false);

    a.ws.close();
    b.ws.close();
    await expect
      .poll(
        async () => {
          const left = (await publisher.pubsub("CHANNELS", "rt:org:it-*")) as string[];
          return left.filter((c) => c === realtimeChannel(orgA) || c === realtimeChannel(orgB)).length;
        },
        { timeout: 5000 },
      )
      .toBe(0);
  });

  it("depois de uma queda da conexão com o Valkey, reassina os canais ativos sozinho", async () => {
    const a = await open(port, "sid=a");
    // derruba todas as conexões em modo assinante (inclusive a do servidor)
    await publisher.client("KILL", "TYPE", "pubsub");
    let n = 0;
    await expect
      .poll(
        async () => {
          n += 1;
          await publisher.publish(realtimeChannel(orgA), JSON.stringify(envelope(orgA, `apos-queda-${n}`)));
          return a.messages.some((m) => String(m.id).startsWith("apos-queda-"));
        },
        { timeout: 10_000, interval: 200 },
      )
      .toBe(true);
    a.ws.close();
  });
});
