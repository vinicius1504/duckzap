import { describe, expect, it } from "vitest";
import { inboundEventSchema, MAX_PRESENCE_MS, MAX_TYPING_MS, outboundMessageSchema, ProviderError, type ChannelRef } from "../../../lib/messaging";
import { PRESENCE_WEBHOOK_EVENT, EvolutionProvider } from "./evolution";
import type { FetchLike } from "./shared";

/** Presença/"digitando…" no adaptador da Evolution: formato exato dos pedidos (corpo JSON) e do que sai do webhook. */

const URL_ = "https://api.example.com/v1/webhooks/wa/evolution/dzwh_token";
const channel: ChannelRef = {
  id: "c1",
  organizationId: "org_a",
  credentials: { instanceName: "dz-test-instance", webhookSecret: "dzes_secret_value_123", instanceToken: "INSTANCE-TOKEN-0001" },
  webhookUrl: URL_,
};

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | undefined };
function setup(respond: (call: Call) => Response, options: { presenceEnabled?: boolean } = {}) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  const provider = new EvolutionProvider({ baseUrl: "http://evolution.test", apiKey: "GLOBAL-KEY-0001", fetch, sleep: async () => {}, now: () => new Date("2026-10-27T14:00:00Z"), ...options });
  return { provider, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Evolution: sendPresence", () => {
  it("POST /chat/sendPresence/{instância} com { number, presence, delay } e a chave da instância", async () => {
    const { provider, calls } = setup(() => json({ presence: "composing" }, 201));
    await provider.sendPresence!(channel, { to: "+55 (67) 99999-0000", presence: "composing", durationMs: 5000 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("http://evolution.test/chat/sendPresence/dz-test-instance");
    expect(call!.method).toBe("POST");
    expect(call!.headers.apikey).toBe("INSTANCE-TOKEN-0001");
    expect(call!.body).toEqual({ number: "5567999990000", presence: "composing", delay: 5000 });
  });

  it("limita o delay ao teto e arredonda; aceita recording e paused", async () => {
    const { provider, calls } = setup(() => json({}, 201));
    await provider.sendPresence!(channel, { to: "5567999990000", presence: "recording", durationMs: 999_999 });
    await provider.sendPresence!(channel, { to: "5567999990000", presence: "paused", durationMs: 0.4 });
    expect(calls[0]!.body).toMatchObject({ presence: "recording", delay: MAX_PRESENCE_MS });
    expect(calls[1]!.body).toMatchObject({ presence: "paused", delay: 1 });
  });

  it("número que não é telefone nem chega a chamar o provedor", async () => {
    const { provider, calls } = setup(() => json({}));
    await expect(provider.sendPresence!(channel, { to: "@usuario", presence: "composing", durationMs: 1000 })).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(0);
  });

  it("traduz falhas em ProviderError sem vazar a chave", async () => {
    for (const [status, code] of [
      [401, "invalid_credentials"],
      [404, "rejected"],
      [429, "unavailable"],
      [500, "unavailable"],
    ] as const) {
      const { provider } = setup(() => json({ error: "x" }, status));
      const error = await provider.sendPresence!(channel, { to: "5567999990000", presence: "composing", durationMs: 1000 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe(code);
      expect(String((error as ProviderError).message)).not.toContain("INSTANCE-TOKEN-0001");
    }
    const down = new EvolutionProvider({ baseUrl: "http://evolution.test", apiKey: "k", fetch: async () => Promise.reject(new Error("ECONNREFUSED")) });
    await expect(down.sendPresence(channel, { to: "5567999990000", presence: "composing", durationMs: 1000 })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("PRESENCE_ENABLED=false: sem capacidade e sem chamada", async () => {
    const { provider, calls } = setup(() => json({}), { presenceEnabled: false });
    expect(provider.capabilities().presence).toBe(false);
    await provider.sendPresence!(channel, { to: "5567999990000", presence: "composing", durationMs: 1000 });
    expect(calls).toHaveLength(0);
  });
});

describe("Evolution: send() com typingMs (delay nativo)", () => {
  const sent = () => json({ key: { id: "BAE5F4A1B2C3" } }, 201);

  it("texto: delay no corpo do sendText", async () => {
    const { provider, calls } = setup(sent);
    const result = await provider.send(channel, { externalId: "e1", to: "+5567999990000", kind: "text", text: "Olá", typingMs: 2100 });
    expect(result).toEqual({ ok: true, providerMessageId: "BAE5F4A1B2C3" });
    expect(calls[0]!.url).toBe("http://evolution.test/message/sendText/dz-test-instance");
    expect(calls[0]!.body).toEqual({ number: "5567999990000", text: "Olá", delay: 2100 });
  });

  it("mídia: delay no corpo do sendMedia", async () => {
    const { provider, calls } = setup(sent);
    await provider.send(channel, { externalId: "e2", to: "+5567999990000", kind: "image", mediaUrl: "https://cdn.example.com/a.png", text: "Legenda", typingMs: 900 });
    expect(calls[0]!.url).toBe("http://evolution.test/message/sendMedia/dz-test-instance");
    expect(calls[0]!.body).toMatchObject({ number: "5567999990000", mediatype: "image", caption: "Legenda", delay: 900 });
  });

  it("sem typingMs (ou 0) o corpo é o de sempre, sem delay", async () => {
    const { provider, calls } = setup(sent);
    await provider.send(channel, { externalId: "e3", to: "+5567999990000", kind: "text", text: "Olá" });
    await provider.send(channel, { externalId: "e4", to: "+5567999990000", kind: "text", text: "Olá", typingMs: 0 });
    expect(calls[0]!.body).toEqual({ number: "5567999990000", text: "Olá" });
    expect(calls[1]!.body).toEqual({ number: "5567999990000", text: "Olá" });
  });

  it("PRESENCE_ENABLED=false: ignora typingMs", async () => {
    const { provider, calls } = setup(sent, { presenceEnabled: false });
    await provider.send(channel, { externalId: "e5", to: "+5567999990000", kind: "text", text: "Olá", typingMs: 3000 });
    expect(calls[0]!.body).toEqual({ number: "5567999990000", text: "Olá" });
  });

  it("o schema da mensagem limita typingMs ao teto compartilhado", () => {
    const base = { externalId: "e", to: "+5567999990000", kind: "text" as const, text: "oi" };
    expect(outboundMessageSchema.safeParse({ ...base, typingMs: MAX_TYPING_MS }).success).toBe(true);
    expect(outboundMessageSchema.safeParse({ ...base, typingMs: MAX_TYPING_MS + 1 }).success).toBe(false);
    expect(outboundMessageSchema.safeParse({ ...base, typingMs: -1 }).success).toBe(false);
    expect(outboundMessageSchema.safeParse({ ...base, typingMs: 1.5 }).success).toBe(false);
  });
});

describe("Evolution: webhook pede PRESENCE_UPDATE", () => {
  it("instance/create registra o evento extra", async () => {
    const { provider, calls } = setup((call) => {
      if (call.url.includes("/instance/connect/")) return json({ error: "not found" }, 404);
      if (call.url.endsWith("/instance/create")) return json({ hash: "NEW-TOKEN", qrcode: { code: "2@qr", pairingCode: "ABCD" } }, 201);
      if (call.url.includes("/instance/connectionState/")) return json({ instance: { state: "connecting" } });
      return json({});
    });
    await provider.connect(channel);
    const create = calls.find((c) => c.url.endsWith("/instance/create"));
    const webhook = create!.body!.webhook as { events: string[] };
    expect(webhook.events).toContain(PRESENCE_WEBHOOK_EVENT);
    expect(webhook.events).toContain("MESSAGES_UPSERT");
  });

  it("com PRESENCE_ENABLED=false o evento não é pedido", async () => {
    const { provider, calls } = setup(() => json({}), { presenceEnabled: false });
    await provider.updateWebhook(channel);
    expect((calls[0]!.body!.webhook as { events: string[] }).events).not.toContain(PRESENCE_WEBHOOK_EVENT);
  });
});

describe("Evolution: syncWebhook (instâncias antigas)", () => {
  const allEvents = ["QRCODE_UPDATED", "CONNECTION_UPDATE", "MESSAGES_UPSERT", "MESSAGES_UPDATE", "PRESENCE_UPDATE"];

  it("webhook completo: só consulta (GET /webhook/find), não escreve", async () => {
    const { provider, calls } = setup(() => json({ enabled: true, url: URL_, events: allEvents }));
    expect(await provider.syncWebhook(channel)).toBe("unchanged");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET http://evolution.test/webhook/find/dz-test-instance"]);
    expect(calls[0]!.headers.apikey).toBe("GLOBAL-KEY-0001");
  });

  it("sem PRESENCE_UPDATE: reaplica com POST /webhook/set e o evento novo", async () => {
    const { provider, calls } = setup((call) => (call.method === "GET" ? json({ enabled: true, url: URL_, events: allEvents.slice(0, 4) }) : json({}, 201)));
    expect(await provider.syncWebhook(channel)).toBe("updated");
    const set = calls.find((c) => c.method === "POST");
    expect(set!.url).toBe("http://evolution.test/webhook/set/dz-test-instance");
    const webhook = set!.body!.webhook as { url: string; enabled: boolean; events: string[] };
    expect(webhook.events).toEqual(allEvents);
    expect(webhook.url).toBe(URL_);
    expect(webhook.enabled).toBe(true);
  });

  it("URL diferente ou desligado também reaplica; resposta ilegível reaplica (idempotente)", async () => {
    for (const found of [{ enabled: true, url: "https://velho.example.com/x", events: allEvents }, { enabled: false, url: URL_, events: allEvents }, null]) {
      const { provider } = setup((call) => (call.method === "GET" ? json(found) : json({}, 201)));
      expect(await provider.syncWebhook(channel)).toBe("updated");
    }
  });

  it("falha do provedor ao reaplicar vira ProviderError (o job conta e segue)", async () => {
    const { provider } = setup((call) => (call.method === "GET" ? json({}, 404) : json({}, 500)));
    await expect(provider.syncWebhook(channel)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("Evolution: presence.update → evento canônico", () => {
  const parse = async (payload: unknown, options: { presenceEnabled?: boolean } = {}) => {
    const { provider } = setup(() => json({}), options);
    return provider.parseWebhook(new Request("https://x.test/", { method: "POST", body: JSON.stringify(payload) }), channel);
  };
  const chat = "5567999990000@s.whatsapp.net";
  const payload = (presences: unknown, id = chat) => ({ event: "presence.update", instance: "dz-test-instance", date_time: "2026-10-27T14:00:00.000Z", data: { id, presences } });

  it("composing → evento válido com o telefone em E.164 e a data do webhook", async () => {
    const events = await parse(payload({ [chat]: { lastKnownPresence: "composing" } }));
    expect(events).toEqual([{ type: "presence", from: "+5567999990000", presence: "composing", at: "2026-10-27T14:00:00.000Z" }]);
    expect(inboundEventSchema.safeParse(events[0]).success).toBe(true);
  });

  it("aceita o nome do evento em MAIÚSCULAS com underscore (PRESENCE_UPDATE)", async () => {
    const events = await parse({ ...payload({ [chat]: { lastKnownPresence: "paused" } }), event: "PRESENCE_UPDATE" });
    expect(events).toHaveLength(1);
  });

  it("ignora grupo, transmissão, status e chat @lid", async () => {
    for (const id of ["120363025246125486@g.us", "status@broadcast", "5567999990000@broadcast", "123456789012345@lid"]) {
      expect(await parse(payload({ [id]: { lastKnownPresence: "composing" } }, id))).toEqual([]);
    }
  });

  it("ignora valor desconhecido, presença de outra pessoa e corpo sem presences", async () => {
    expect(await parse(payload({ [chat]: { lastKnownPresence: "typing-something-new" } }))).toEqual([]);
    expect(await parse(payload({ "5511988887777@s.whatsapp.net": { lastKnownPresence: "composing" } }))).toEqual([]);
    expect(await parse(payload(undefined))).toEqual([]);
    expect(await parse({ event: "presence.update", data: null })).toEqual([]);
  });

  it("PRESENCE_ENABLED=false: ignora", async () => {
    expect(await parse(payload({ [chat]: { lastKnownPresence: "composing" } }), { presenceEnabled: false })).toEqual([]);
  });
});
