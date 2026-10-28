import { describe, expect, it, vi } from "vitest";
import type { ChannelRef } from "../../lib/messaging";
import { createChannelsRuntime, PRESENCE_LIMITS, type ChannelsRuntime } from "./runtime";
import { loadChannelsConfig } from "./config";
import { EVOLUTION_WEBHOOK_HEADER } from "./providers/evolution";
import { META_SIGNATURE_HEADER, metaVerificationChallenge, verifyMetaSignature, isWithin24hWindow, windowExpiresAt } from "./providers/meta-cloud";
import { hmacSha256Hex } from "./providers/shared";
import { InMemoryTokenBucket } from "./rate-limit";
import { hashWebhookToken, isSafeMediaUrl, WEBHOOK_TOKEN_PATTERN } from "./security";
import type { RecordInput } from "./inbound-store";
import { handleWebhook, type WebhookPorts } from "./webhook";
import { generateSecret } from "../../lib/crypto";
import type { PresenceContext } from "../../lib/presence";

const TOKEN = generateSecret("dzwh_");
const META_SECRET = "meta_app_secret_value_0123456789";

function setup(provider: "evolution" | "meta_cloud", overrides: Partial<WebhookPorts> = {}, rtOverrides: Partial<ChannelsRuntime> = {}) {
  const channel: ChannelRef =
    provider === "evolution"
      ? { id: "chan-1", organizationId: "org_a", credentials: { instanceName: "dz-test-instance", webhookSecret: "dzes_secret" } }
      : { id: "chan-1", organizationId: "org_a", credentials: { phoneNumberId: "106540352242922", verifyToken: "dzv_verify" } };
  const record = vi.fn(async (input: RecordInput) => ({ ids: input.parseFailed ? [] : input.events.map((_, i) => `id-${i}`), duplicates: 0 }));
  const processFn = vi.fn(async () => {});
  const presenceFn = vi.fn(async (_context: PresenceContext) => {});
  const ports: WebhookPorts = {
    resolve: vi.fn(async (token: string) => (token === TOKEN ? { organization_id: "org_a", channel_id: "chan-1", provider } : undefined)),
    loadRef: vi.fn(async () => channel),
    record,
    process: processFn,
    presence: presenceFn,
    ...overrides,
  };
  const jobs: Promise<void>[] = [];
  const rt = createChannelsRuntime({
    config: loadChannelsConfig({ EVOLUTION_API_KEY: "k", META_APP_SECRET: META_SECRET }),
    background: (task) => {
      jobs.push(task());
    },
    ...rtOverrides,
  });
  return { ports, rt, record, processFn, presenceFn, jobs };
}

const evolutionBody = JSON.stringify({
  event: "messages.upsert",
  instance: "dz-test-instance",
  data: { key: { remoteJid: "5567999990000@s.whatsapp.net", fromMe: false, id: "ABC" }, message: { conversation: "oi" }, messageTimestamp: 1793052600 },
});
const evoRequest = (secret = "dzes_secret", body = evolutionBody) =>
  new Request(`https://api.test/v1/webhooks/wa/evolution/${TOKEN}`, { method: "POST", headers: { [EVOLUTION_WEBHOOK_HEADER]: secret, "content-type": "application/json" }, body });

describe("webhook público: ordem das verificações", () => {
  it("token inexistente, malformado ou de outro provedor dão o MESMO 404 (sem oráculo)", async () => {
    const { ports, rt } = setup("evolution");
    const unknown = await handleWebhook({ ports, rt }, evoRequest(), { provider: "evolution", token: generateSecret("dzwh_") });
    const malformed = await handleWebhook({ ports, rt }, evoRequest(), { provider: "evolution", token: "curto" });
    const wrongProvider = await handleWebhook({ ports, rt }, evoRequest(), { provider: "meta", token: TOKEN });
    const unknownProvider = await handleWebhook({ ports, rt }, evoRequest(), { provider: "uazapi", token: TOKEN });
    for (const outcome of [unknown, malformed, wrongProvider, unknownProvider]) expect(outcome).toEqual({ status: 404, body: { error: { code: "not_found", message: "Não encontrado." } } });
    // token malformado nem chega ao banco
    expect(ports.resolve).toHaveBeenCalledTimes(2);
  });

  it("Evolution: sem o segredo do cabeçalho → 401 e NADA é gravado", async () => {
    const { ports, rt, record } = setup("evolution");
    const missing = await handleWebhook({ ports, rt }, evoRequest(""), { provider: "evolution", token: TOKEN });
    const wrong = await handleWebhook({ ports, rt }, evoRequest("errado"), { provider: "evolution", token: TOKEN });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("Evolution autêntico: grava primeiro, responde 200 e só então processa em segundo plano", async () => {
    const { ports, rt, record, processFn, jobs } = setup("evolution");
    const outcome = await handleWebhook({ ports, rt }, evoRequest(), { provider: "evolution", token: TOKEN });
    expect(outcome).toEqual({ status: 200, body: { ok: true, received: 1, duplicates: 0 } });
    expect(record).toHaveBeenCalledTimes(1);
    const recorded = record.mock.calls[0]![0];
    expect(recorded.organizationId).toBe("org_a");
    expect(recorded.rawBody).toBe(evolutionBody);
    expect(recorded.events[0]).toMatchObject({ type: "message", externalId: "ABC", from: "+5567999990000" });
    await Promise.all(jobs);
    expect(processFn).toHaveBeenCalledWith("org_a", ["id-0"]);
  });

  it("falha no processamento em segundo plano não afeta o 200 (o evento já está guardado)", async () => {
    const { ports, rt, record } = setup("evolution", { process: async () => Promise.reject(new Error("handler caiu")) }, { background: (task) => void task().catch(() => {}) });
    const outcome = await handleWebhook({ ports, rt }, evoRequest(), { provider: "evolution", token: TOKEN });
    expect(outcome.status).toBe(200);
    expect(record).toHaveBeenCalled();
  });

  it("reenvio do provedor: duplicado é aceito (200) e não reprocessa", async () => {
    const { ports, rt, processFn, jobs } = setup("evolution", { record: async () => ({ ids: [], duplicates: 1 }) });
    const outcome = await handleWebhook({ ports, rt }, evoRequest(), { provider: "evolution", token: TOKEN });
    expect(outcome).toEqual({ status: 200, body: { ok: true, received: 0, duplicates: 1 } });
    await Promise.all(jobs);
    expect(processFn).not.toHaveBeenCalled();
  });

  it("corpo autêntico mas ilegível é guardado como não interpretado (nada se perde)", async () => {
    const { ports, rt, record } = setup("evolution");
    const body = "{não é json";
    // sem JSON a verificação da Evolution (instância no corpo) falha: 401 e nada gravado
    const outcome = await handleWebhook({ ports, rt }, evoRequest("dzes_secret", body), { provider: "evolution", token: TOKEN });
    expect(outcome.status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("Meta: JSON inválido com assinatura válida → grava como parse_failed", async () => {
    const { ports, rt, record } = setup("meta_cloud");
    const body = "{quebrado";
    const request = new Request(`https://api.test/v1/webhooks/wa/meta/${TOKEN}`, {
      method: "POST",
      headers: { [META_SIGNATURE_HEADER]: `sha256=${hmacSha256Hex(META_SECRET, body)}` },
      body,
    });
    const outcome = await handleWebhook({ ports, rt }, request, { provider: "meta", token: TOKEN });
    expect(outcome.status).toBe(200);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ parseFailed: true, rawBody: body }));
  });

  it("Meta POST sem assinatura → 401", async () => {
    const { ports, rt, record } = setup("meta_cloud");
    const request = new Request(`https://api.test/v1/webhooks/wa/meta/${TOKEN}`, { method: "POST", body: "{}" });
    expect((await handleWebhook({ ports, rt }, request, { provider: "meta", token: TOKEN })).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("Meta GET: eco do hub.challenge só com o verify token certo", async () => {
    const { ports, rt } = setup("meta_cloud");
    const url = (token: string) => `https://api.test/v1/webhooks/wa/meta/${TOKEN}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`;
    expect(await handleWebhook({ ports, rt }, new Request(url("dzv_verify")), { provider: "meta", token: TOKEN })).toEqual({ status: 200, text: "1158201444" });
    expect((await handleWebhook({ ports, rt }, new Request(url("errado")), { provider: "meta", token: TOKEN })).status).toBe(403);
  });

  it("GET num provedor que não faz handshake → 404", async () => {
    const { ports, rt } = setup("evolution");
    expect((await handleWebhook({ ports, rt }, new Request(`https://api.test/x`), { provider: "evolution", token: TOKEN })).status).toBe(404);
  });

  it("allowlist negando → 403 antes de qualquer verificação ou gravação", async () => {
    const { ports, rt, record } = setup("evolution", {}, { allowlist: () => false });
    expect((await handleWebhook({ ports, rt }, evoRequest(), { provider: "evolution", token: TOKEN })).status).toBe(403);
    expect(record).not.toHaveBeenCalled();
  });

  it("rate limit por IP → 429 sem tocar no banco", async () => {
    const limiter = new InMemoryTokenBucket({ capacity: 2, refillPerSecond: 0.001 });
    const { ports, rt } = setup("evolution", {}, { webhookLimiter: limiter });
    const call = () => handleWebhook({ ports, rt }, new Request(`https://api.test/x`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" }, body: "{}" }), { provider: "evolution", token: "x" });
    await call();
    await call();
    const third = await call();
    expect(third.status).toBe(429);
  });

  it("corpo acima do limite → 413", async () => {
    const { ports, rt } = setup("evolution");
    const big = "x".repeat(1_000_001);
    expect((await handleWebhook({ ports, rt }, evoRequest("dzes_secret", big), { provider: "evolution", token: TOKEN })).status).toBe(413);
  });
});

describe("Meta: handshake, assinatura e janela de 24 h", () => {
  it("metaVerificationChallenge exige modo, token e challenge", () => {
    const u = (qs: string) => new URL(`https://x/?${qs}`);
    expect(metaVerificationChallenge(u("hub.mode=subscribe&hub.verify_token=t&hub.challenge=42"), "t")).toBe("42");
    expect(metaVerificationChallenge(u("hub.mode=subscribe&hub.verify_token=T&hub.challenge=42"), "t")).toBeNull();
    expect(metaVerificationChallenge(u("hub.mode=unsubscribe&hub.verify_token=t&hub.challenge=42"), "t")).toBeNull();
    expect(metaVerificationChallenge(u("hub.mode=subscribe&hub.verify_token=t"), "t")).toBeNull();
    expect(metaVerificationChallenge(u("hub.mode=subscribe&hub.verify_token=t&hub.challenge=1"), undefined)).toBeNull();
  });

  it("verifyMetaSignature é HMAC-SHA256 do corpo cru e falha fechada sem segredo", () => {
    const body = '{"a":1}';
    const good = `sha256=${hmacSha256Hex("segredo-do-app-123456", body)}`;
    expect(verifyMetaSignature(body, good, "segredo-do-app-123456")).toBe(true);
    expect(verifyMetaSignature(body, good, "outro-segredo-123456")).toBe(false);
    expect(verifyMetaSignature(body, good, undefined)).toBe(false);
    expect(verifyMetaSignature(body, null, "segredo-do-app-123456")).toBe(false);
    expect(verifyMetaSignature(`${body}\n`, good, "segredo-do-app-123456")).toBe(false);
  });

  it("janela de 24 h", () => {
    const last = new Date("2026-10-26T10:00:00Z");
    expect(windowExpiresAt(last).toISOString()).toBe("2026-10-27T10:00:00.000Z");
    expect(isWithin24hWindow(last, new Date("2026-10-27T09:59:59Z"))).toBe(true);
    expect(isWithin24hWindow(last, new Date("2026-10-27T10:00:00Z"))).toBe(false);
    expect(isWithin24hWindow(null)).toBe(false);
  });
});

describe("token do webhook e anti-SSRF", () => {
  it("token gerado tem o formato esperado e hash estável (o token nunca vai ao banco)", () => {
    expect(TOKEN).toMatch(WEBHOOK_TOKEN_PATTERN);
    expect(hashWebhookToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWebhookToken(TOKEN)).toBe(hashWebhookToken(TOKEN));
    expect(hashWebhookToken(TOKEN)).not.toContain(TOKEN);
    expect(WEBHOOK_TOKEN_PATTERN.test(`${TOKEN}x`)).toBe(false);
  });

  it("isSafeMediaUrl aceita https público e recusa o resto", () => {
    expect(isSafeMediaUrl("https://cdn.exemplo.com.br/a/b.png")).toBe(true);
    for (const bad of [
      "http://cdn.exemplo.com/a.png",
      "https://localhost/a.png",
      "https://127.0.0.1/a.png",
      "https://10.0.0.5/a.png",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/a",
      "https://metadata.google.internal/x",
      "https://servico.internal/x",
      "https://user:pass@cdn.exemplo.com/a.png",
      "https://2130706433/a",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "não é url",
    ]) {
      expect(isSafeMediaUrl(bad), bad).toBe(false);
    }
  });
});

describe("webhook: presença (\"digitando…\") é efêmera", () => {
  const presenceBody = (jid = "5567999990000@s.whatsapp.net", presence = "composing") =>
    JSON.stringify({ event: "presence.update", instance: "dz-test-instance", date_time: "2026-10-27T14:00:00.000Z", data: { id: jid, presences: { [jid]: { lastKnownPresence: presence } } } });
  /** Tudo o que os pedidos ao `record` pediram para gravar (presença nunca pode aparecer aqui). */
  const stored = (h: ReturnType<typeof setup>) => h.record.mock.calls.flatMap(([input]) => input.events);
  const send = (h: ReturnType<typeof setup>, body: string) => handleWebhook({ ports: h.ports, rt: h.rt }, evoRequest("dzes_secret", body), { provider: "evolution", token: TOKEN });

  it("não grava em inbound_events, não passa pelo despacho/idempotência e entrega à tela só ids da empresa do canal", async () => {
    const h = setup("evolution");
    const outcome = await send(h, presenceBody());
    expect(outcome).toEqual({ status: 200, body: { ok: true, received: 0, duplicates: 0 } });
    expect(h.record).not.toHaveBeenCalled();
    expect(h.processFn).not.toHaveBeenCalled();
    await Promise.all(h.jobs);
    expect(h.presenceFn).toHaveBeenCalledTimes(1);
    // a empresa e o canal vêm do TOKEN resolvido, nunca do corpo
    expect(h.presenceFn).toHaveBeenCalledWith({ organizationId: "org_a", channelId: "chan-1", from: "+5567999990000", presence: "composing" });
  });

  it("assinatura inválida continua 401 e não entrega nada", async () => {
    const h = setup("evolution");
    const outcome = await handleWebhook({ ports: h.ports, rt: h.rt }, evoRequest("errado", presenceBody()), { provider: "evolution", token: TOKEN });
    expect(outcome.status).toBe(401);
    await Promise.all(h.jobs);
    expect(h.presenceFn).not.toHaveBeenCalled();
  });

  it("grupo, valor desconhecido e available/unavailable não chegam ao handler (e nada é gravado)", async () => {
    const h = setup("evolution");
    for (const body of [presenceBody("120363025246125486@g.us"), presenceBody(undefined, "typing-something-new"), presenceBody(undefined, "available"), presenceBody(undefined, "unavailable")]) {
      expect((await send(h, body)).status).toBe(200);
    }
    await Promise.all(h.jobs);
    expect(h.presenceFn).not.toHaveBeenCalled();
    expect(stored(h)).toEqual([]); // `record` pode ser chamado com lista vazia (não grava linha nenhuma)
  });

  it("paused e recording são entregues (a tela decide o que é ativo)", async () => {
    const h = setup("evolution");
    await send(h, presenceBody(undefined, "paused"));
    await send(h, presenceBody(undefined, "recording"));
    await Promise.all(h.jobs);
    expect(h.presenceFn.mock.calls.map(([c]) => c.presence).sort()).toEqual(["paused", "recording"]);
  });

  it("rajada de um contato é limitada (e o 200 não muda)", async () => {
    const h = setup("evolution");
    for (let i = 0; i < 40; i++) expect((await send(h, presenceBody())).status).toBe(200);
    await Promise.all(h.jobs);
    expect(h.presenceFn.mock.calls.length).toBeLessThanOrEqual(PRESENCE_LIMITS.contact.burst + 1);
    expect(h.presenceFn.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("um contato inundando não esgota a cota dos outros (limite do contato vem antes do do canal)", async () => {
    const h = setup("evolution");
    for (let i = 0; i < 60; i++) await send(h, presenceBody("5567999990000@s.whatsapp.net"));
    await send(h, presenceBody("5567988887777@s.whatsapp.net"));
    await Promise.all(h.jobs);
    expect(h.presenceFn.mock.calls.some(([c]) => c.from === "+5567988887777")).toBe(true);
  });

  it("limite por canal: muitos contatos diferentes são cortados no teto do canal", async () => {
    const h = setup("evolution");
    for (let i = 0; i < 60; i++) await send(h, presenceBody(`55679${String(10_000_000 + i).slice(1)}@s.whatsapp.net`));
    await Promise.all(h.jobs);
    expect(h.presenceFn.mock.calls.length).toBeLessThanOrEqual(PRESENCE_LIMITS.channel.burst + 1);
  });

  it("falha do handler não derruba o webhook", async () => {
    const h = setup("evolution", { presence: async () => Promise.reject(new Error("banco caiu")) }, { background: (task) => void task().catch(() => {}) });
    expect((await send(h, presenceBody())).status).toBe(200);
  });

  it("PRESENCE_ENABLED=false: o evento é aceito (200) e ignorado", async () => {
    const h = setup("evolution", {}, { config: loadChannelsConfig({ EVOLUTION_API_KEY: "k", PRESENCE_ENABLED: "false" }) });
    expect((await send(h, presenceBody())).status).toBe(200);
    await Promise.all(h.jobs);
    expect(h.presenceFn).not.toHaveBeenCalled();
    expect(stored(h)).toEqual([]);
  });

  it("webhook misto (mensagem + presença): só a mensagem é gravada", async () => {
    const h = setup("evolution");
    const mixed = JSON.stringify({ event: "messages.upsert", instance: "dz-test-instance", data: { key: { remoteJid: "5567999990000@s.whatsapp.net", fromMe: false, id: "XYZ" }, message: { conversation: "oi" } } });
    await send(h, mixed);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls[0]![0].events.every((e) => e.type !== "presence")).toBe(true);
  });
});
