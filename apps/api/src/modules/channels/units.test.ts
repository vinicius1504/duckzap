import { describe, expect, it, vi } from "vitest";
import type { InboundEvent } from "../../lib/messaging";
import { loadChannelsConfig, webhookUrl } from "./config";
import { eventKey, nextStatus, rawPayload, unparsedKey } from "./inbound-store";
import { allowedChannelTypes, checkCanCreate } from "./plan-limits";
import { InMemoryQueue } from "./queue";
import { InMemoryTokenBucket } from "./rate-limit";

describe("limites do plano (§1.2)", () => {
  const essencial = { maxChannels: 2, features: [] };
  const escala = { maxChannels: 15, features: ["campaigns", "instagram", "copilot"] };

  it("Instagram só com a feature `instagram`", () => {
    expect(allowedChannelTypes(essencial)).toEqual(["whatsapp_qr", "whatsapp_official"]);
    expect(allowedChannelTypes(escala)).toContain("instagram");
    expect(checkCanCreate(essencial, 0, "instagram")).toMatchObject({ ok: false, code: "type_not_allowed" });
    expect(checkCanCreate(escala, 0, "instagram")).toEqual({ ok: true });
  });

  it("bloqueia ao atingir o máximo de canais, qualquer que seja o tipo", () => {
    expect(checkCanCreate(essencial, 1, "whatsapp_qr")).toEqual({ ok: true });
    expect(checkCanCreate(essencial, 2, "whatsapp_qr")).toMatchObject({ ok: false, code: "plan_limit" });
    expect(checkCanCreate(essencial, 3, "whatsapp_official")).toMatchObject({ ok: false, code: "plan_limit" });
  });

  it("o limite vence a restrição de tipo (mensagem do limite primeiro)", () => {
    expect(checkCanCreate(essencial, 2, "instagram")).toMatchObject({ code: "plan_limit" });
  });

  it("plano desconhecido (0 canais) não cria nada", () => {
    expect(checkCanCreate({ maxChannels: 0, features: [] }, 0, "whatsapp_qr")).toMatchObject({ ok: false, code: "plan_limit" });
  });
});

describe("idempotência: chaves de deduplicação", () => {
  const message: InboundEvent = { type: "message", externalId: "wamid.1", from: "+5567999990000", kind: "text", text: "oi", at: "2026-10-26T10:00:00.000Z" };

  it("a mesma mensagem reenviada gera a mesma chave; mensagens diferentes, chaves diferentes", () => {
    expect(eventKey(message)).toBe(eventKey({ ...message, text: "texto editado no reenvio" }));
    expect(eventKey(message)).not.toBe(eventKey({ ...message, externalId: "wamid.2" }));
  });

  it("status é por (mensagem, status): entregue e lido são eventos distintos", () => {
    const delivered: InboundEvent = { type: "status", externalId: "wamid.9", status: "delivered", at: "2026-10-26T10:00:00.000Z" };
    expect(eventKey(delivered)).toBe(eventKey({ ...delivered, at: "2026-10-26T10:05:00.000Z" }));
    expect(eventKey(delivered)).not.toBe(eventKey({ ...delivered, status: "read" }));
  });

  it("QRs diferentes do mesmo instante não colidem", () => {
    const a: InboundEvent = { type: "connection", status: "qr_pending", qrCode: "QR-A", at: "2026-10-26T10:00:00.000Z" };
    expect(eventKey(a)).not.toBe(eventKey({ ...a, qrCode: "QR-B" }));
    expect(eventKey(a)).toBe(eventKey({ ...a }));
  });

  it("chave de corpo ilegível depende do conteúdo e corpo não-JSON é preservado", () => {
    expect(unparsedKey("abc")).toBe(unparsedKey("abc"));
    expect(unparsedKey("abc")).not.toBe(unparsedKey("abd"));
    expect(rawPayload('{"a":1}')).toEqual({ a: 1 });
    expect(rawPayload("lixo")).toEqual({ unparsedBody: "lixo" });
  });
});

describe("transições de status vindas do provedor", () => {
  it("conectou/banido sempre valem", () => {
    expect(nextStatus("qr_pending", "connected")).toBe("connected");
    expect(nextStatus("connected", "banned")).toBe("banned");
  });
  it("queda só vale se estava conectado (a Evolution emite `close` durante o pareamento)", () => {
    expect(nextStatus("connected", "disconnected")).toBe("disconnected");
    expect(nextStatus("qr_pending", "disconnected")).toBeNull();
    expect(nextStatus("disconnected", "disconnected")).toBeNull();
  });
  it("`connecting`/novo QR não derruba canal conectado", () => {
    expect(nextStatus("connected", "qr_pending")).toBeNull();
    expect(nextStatus("disconnected", "qr_pending")).toBe("qr_pending");
  });
});

describe("balde de fichas (rate limit por canal)", () => {
  it("permite a rajada, bloqueia o excesso e repõe com o tempo", async () => {
    let now = 0;
    const bucket = new InMemoryTokenBucket({ capacity: 3, refillPerSecond: 1, now: () => now });
    expect((await bucket.take("canal-a")).allowed).toBe(true);
    expect((await bucket.take("canal-a")).allowed).toBe(true);
    expect((await bucket.take("canal-a")).allowed).toBe(true);
    const blocked = await bucket.take("canal-a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
    now += 1000;
    expect((await bucket.take("canal-a")).allowed).toBe(true);
    expect((await bucket.take("canal-a")).allowed).toBe(false);
  });

  it("canais não dividem balde", async () => {
    const bucket = new InMemoryTokenBucket({ capacity: 1, refillPerSecond: 0.001, now: () => 0 });
    expect((await bucket.take("a")).allowed).toBe(true);
    expect((await bucket.take("a")).allowed).toBe(false);
    expect((await bucket.take("b")).allowed).toBe(true);
  });

  it("não passa da capacidade mesmo depois de muito tempo parado", async () => {
    let now = 0;
    const bucket = new InMemoryTokenBucket({ capacity: 2, refillPerSecond: 10, now: () => now });
    await bucket.take("a");
    now += 3_600_000;
    expect((await bucket.take("a")).allowed).toBe(true);
    expect((await bucket.take("a")).allowed).toBe(true);
    expect((await bucket.take("a")).allowed).toBe(false);
  });

  it("descarta chaves antigas (memória limitada)", async () => {
    const bucket = new InMemoryTokenBucket({ capacity: 1, refillPerSecond: 0.001, now: () => 0, maxKeys: 2 });
    await bucket.take("a");
    await bucket.take("b");
    await bucket.take("c"); // expulsa "a"
    expect((await bucket.take("a")).allowed).toBe(true); // balde novo, cheio
  });
});

describe("fila em memória", () => {
  it("processa, respeita jobId (idempotente) e isola erros do handler", async () => {
    const errors: string[] = [];
    const queue = new InMemoryQueue<number>((name) => errors.push(name));
    const seen: number[] = [];
    queue.process("soma", async (n) => {
      seen.push(n);
      if (n === 99) throw new Error("falhou");
    });
    await queue.enqueue("soma", 1, { jobId: "a" });
    await queue.enqueue("soma", 2, { jobId: "a" }); // duplicado: ignorado
    await queue.enqueue("soma", 99);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual([1, 99]);
    expect(errors).toEqual(["soma"]);
  });

  it("jobs com atraso só rodam depois", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryQueue<string>();
    const handler = vi.fn(async () => {});
    queue.process("later", handler);
    await queue.enqueue("later", "x", { delayMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("configuração do módulo", () => {
  it("valores padrão e Evolution separada da base pública", () => {
    const config = loadChannelsConfig({ PUBLIC_API_URL: "https://api.duckzap.app/", EVOLUTION_WEBHOOK_BASE_URL: "http://host.docker.internal:4000" });
    expect(config.evolutionUrl).toBe("http://localhost:8081");
    expect(config.publicWebhookBaseUrl).toBe("https://api.duckzap.app");
    expect(config.evolutionWebhookBaseUrl).toBe("http://host.docker.internal:4000");
    expect(webhookUrl(config.publicWebhookBaseUrl, "meta", "dzwh_x")).toBe("https://api.duckzap.app/v1/webhooks/wa/meta/dzwh_x");
  });

  it("strings vazias do .env viram padrão; valor inválido derruba o boot", () => {
    expect(loadChannelsConfig({ PUBLIC_WEBHOOK_BASE_URL: "", EVOLUTION_API_KEY: "" }).evolutionApiKey).toBeUndefined();
    expect(() => loadChannelsConfig({ EVOLUTION_URL: "não é url" })).toThrow();
  });
});
