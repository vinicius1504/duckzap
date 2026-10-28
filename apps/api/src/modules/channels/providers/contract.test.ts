import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inboundEventSchema, type ChannelRef, type InboundEvent, type MessagingProvider, type OutboundMessage } from "../../../lib/messaging";
import { EVOLUTION_WEBHOOK_HEADER, EvolutionProvider } from "./evolution";
import { InstagramProvider } from "./instagram";
import { META_SIGNATURE_HEADER, MetaCloudProvider } from "./meta-cloud";
import { createProviderRegistry } from "./registry";
import { hmacSha256Hex, type FetchLike } from "./shared";
import { loadChannelsConfig } from "../config";

/**
 * Suíte de contrato (§3.6): a MESMA bateria roda contra todos os adaptadores, com payloads gravados/documentados de
 * cada provedor em `__fixtures__/`. Fixtures `*.recorded.json` foram capturadas da Evolution v2.3.7 real
 * (instância sem celular); as demais seguem o formato documentado do provedor (não há celular conectado em dev).
 * Adicionar um provedor = novo item em `cases`, sem tocar no domínio.
 */
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;

type Calls = { url: string; init: RequestInit | undefined }[];
function fakeFetch(respond: (url: string, init?: RequestInit) => Response): { fetch: FetchLike; calls: Calls } {
  const calls: Calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
}
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type ParseCase = { fixture: string; expected: Partial<InboundEvent>[] };

type Case = {
  name: string;
  provider: (fetch: FetchLike) => MessagingProvider;
  channel: ChannelRef;
  /** Pedido autêntico (assinado / com segredo) com o corpo dado. */
  authentic(body: string): Request;
  /** Variações que DEVEM ser recusadas. */
  forged: Record<string, (body: string) => Request>;
  parse: ParseCase[];
  /** Respostas simuladas do provedor para o envio de texto. */
  sendOk: Response;
  sendRateLimited: Response;
  secrets: string[];
  skipSend?: boolean;
};

const URL_ = "https://api.example.com/v1/webhooks/wa/x/dzwh_token";
const post = (headers: Record<string, string>, body: string) => new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

const evolutionChannel: ChannelRef = {
  id: "c1",
  organizationId: "org_a",
  credentials: { instanceName: "dz-test-instance", webhookSecret: "dzes_secret_value_123", instanceToken: "INSTANCE-TOKEN-0001" },
  webhookUrl: URL_,
};

const META_SECRET = "meta_app_secret_value_0123456789";
const metaChannel: ChannelRef = {
  id: "c2",
  organizationId: "org_a",
  credentials: { phoneNumberId: "106540352242922", businessAccountId: "102290129340398", accessToken: "EAAG-ACCESS-TOKEN-ABCDEFGHIJ", verifyToken: "dzv_verify" },
  webhookUrl: URL_,
};

const cases: Case[] = [
  {
    name: "evolution",
    provider: (fetch) => new EvolutionProvider({ baseUrl: "http://evolution.test", apiKey: "GLOBAL-KEY-0001", fetch, sleep: async () => {} }),
    channel: evolutionChannel,
    authentic: (body) => post({ [EVOLUTION_WEBHOOK_HEADER]: "dzes_secret_value_123" }, body),
    forged: {
      "sem o cabeçalho de segredo": (body) => post({}, body),
      "segredo errado": (body) => post({ [EVOLUTION_WEBHOOK_HEADER]: "dzes_secret_value_124" }, body),
      "segredo de tamanho diferente": (body) => post({ [EVOLUTION_WEBHOOK_HEADER]: "x" }, body),
      "instância de outro canal": (body) => post({ [EVOLUTION_WEBHOOK_HEADER]: "dzes_secret_value_123" }, body.replace("dz-test-instance", "dz-outra-instancia")),
    },
    parse: [
      { fixture: "evolution.messages-upsert.text", expected: [{ type: "message", kind: "text", from: "+5567999990000", text: "Oi, queria marcar uma limpeza", externalId: "3EB0C767D82A9F43B1E4", name: "Maria Souza" }] },
      { fixture: "evolution.messages-upsert.image", expected: [{ type: "message", kind: "image", text: "Segue o exame", mediaRef: "3EB0AABBCCDDEEFF0011" }] },
      { fixture: "evolution.messages-upsert.from-me", expected: [] },
      { fixture: "evolution.messages-upsert.group", expected: [] },
      { fixture: "evolution.messages-update.read", expected: [{ type: "status", status: "read", externalId: "3EB0OUT000000000001" }] },
      { fixture: "evolution.connection-update.connecting.recorded", expected: [{ type: "connection", status: "qr_pending" }] },
      { fixture: "evolution.connection-update.open", expected: [{ type: "connection", status: "connected" }] },
      { fixture: "evolution.connection-update.close", expected: [{ type: "connection", status: "disconnected" }] },
      { fixture: "evolution.connection-update.banned", expected: [{ type: "connection", status: "banned" }] },
      { fixture: "evolution.qrcode-updated.recorded", expected: [{ type: "connection", status: "qr_pending" }] },
      { fixture: "evolution.presence-update.composing", expected: [{ type: "presence", presence: "composing", from: "+5567999990000" }] },
      { fixture: "evolution.presence-update.recording", expected: [{ type: "presence", presence: "recording", from: "+5567999990000" }] },
      { fixture: "evolution.presence-update.paused", expected: [{ type: "presence", presence: "paused", from: "+5567999990000" }] },
      { fixture: "evolution.presence-update.available", expected: [{ type: "presence", presence: "available", from: "+5567999990000" }] },
      { fixture: "evolution.presence-update.group", expected: [] },
      { fixture: "evolution.presence-update.unknown", expected: [] },
      { fixture: "evolution.presence-update.other-participant", expected: [] },
    ],
    sendOk: jsonResponse({ key: { remoteJid: "5567999990000@s.whatsapp.net", fromMe: true, id: "BAE5F4A1B2C3" }, status: "PENDING" }, 201),
    sendRateLimited: jsonResponse({ status: 429 }, 429),
    secrets: ["GLOBAL-KEY-0001", "INSTANCE-TOKEN-0001", "dzes_secret_value_123"],
  },
  {
    name: "meta_cloud",
    provider: (fetch) => new MetaCloudProvider({ graphUrl: "https://graph.test/v21.0", appSecret: META_SECRET, fetch }),
    channel: metaChannel,
    authentic: (body) => post({ [META_SIGNATURE_HEADER]: `sha256=${hmacSha256Hex(META_SECRET, body)}` }, body),
    forged: {
      "sem assinatura": (body) => post({}, body),
      "assinatura de outro segredo": (body) => post({ [META_SIGNATURE_HEADER]: `sha256=${hmacSha256Hex("outro_segredo_qualquer_123", body)}` }, body),
      "corpo adulterado depois de assinado": (body) => post({ [META_SIGNATURE_HEADER]: `sha256=${hmacSha256Hex(META_SECRET, body)}` }, `${body} `),
      "prefixo errado": (body) => post({ [META_SIGNATURE_HEADER]: hmacSha256Hex(META_SECRET, body) }, body),
      "hex truncado": (body) => post({ [META_SIGNATURE_HEADER]: `sha256=${hmacSha256Hex(META_SECRET, body).slice(0, 10)}` }, body),
    },
    parse: [
      { fixture: "meta.inbound-text", expected: [{ type: "message", kind: "text", from: "+5567988887777", text: "Boa tarde, vocês atendem sábado?", name: "João Lima" }] },
      { fixture: "meta.inbound-image", expected: [{ type: "message", kind: "image", text: "Receita", mediaRef: "1234567890" }] },
      { fixture: "meta.status-delivered", expected: [{ type: "status", status: "delivered" }] },
      { fixture: "meta.status-failed", expected: [{ type: "status", status: "failed" }] },
      { fixture: "meta.other-number", expected: [] },
    ],
    sendOk: jsonResponse({ messaging_product: "whatsapp", contacts: [{ input: "5567999990000", wa_id: "5567999990000" }], messages: [{ id: "wamid.SENT0001" }] }),
    sendRateLimited: jsonResponse({ error: { code: 130429, message: "Rate limit hit" } }, 429),
    secrets: ["EAAG-ACCESS-TOKEN-ABCDEFGHIJ", META_SECRET],
  },
];

const text = (externalId: string): OutboundMessage => ({ externalId, to: "+55 (67) 99999-0000", kind: "text", text: "Olá, tudo bem?" });

describe.each(cases)("contrato do provedor: $name", (c) => {
  const make = (fetch: FetchLike = async () => jsonResponse({})) => c.provider(fetch);

  it("registra kind e capacidades coerentes", () => {
    const provider = make();
    expect(provider.kind).toBe(c.name);
    const caps = provider.capabilities();
    for (const flag of ["buttons", "lists", "templates", "media", "reactions", "window24h", "presence"] as const) expect(typeof caps[flag]).toBe("boolean");
    // o registry resolve o mesmo kind
    const registry = createProviderRegistry(loadChannelsConfig({ EVOLUTION_API_KEY: "k" }));
    expect(registry.get(c.name)?.kind).toBe(c.name);
  });

  it("presença: só declara a capacidade quem implementa sendPresence (Evolution sim; Meta/Instagram não)", () => {
    const provider = make();
    expect(provider.capabilities().presence).toBe(c.name === "evolution");
    expect(typeof provider.sendPresence === "function").toBe(provider.capabilities().presence);
  });

  it("typingMs na mensagem nunca quebra o envio (quem não tem presença não manda delay)", async () => {
    const { fetch, calls } = fakeFetch(() => c.sendOk.clone());
    const result = await make(fetch).send(c.channel, { ...text("ext-typing"), typingMs: 1200 });
    expect(result.ok).toBe(true);
    const sent = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    if (c.name === "evolution") expect(sent.delay).toBe(1200);
    else expect(sent).not.toHaveProperty("delay");
  });

  it("aceita o webhook autêntico", async () => {
    const body = JSON.stringify(fixture(c.parse[0]!.fixture));
    expect(await make().verifyWebhook(c.authentic(body), c.channel)).toBe(true);
  });

  for (const [label] of Object.entries(c.forged)) {
    it(`recusa webhook forjado: ${label}`, async () => {
      const body = JSON.stringify(fixture(c.parse[0]!.fixture));
      const forged = c.forged[label]!;
      expect(await make().verifyWebhook(forged(body), c.channel)).toBe(false);
    });
  }

  it("recusa quando o canal não tem segredo configurado (falha fechada)", async () => {
    const body = JSON.stringify(fixture(c.parse[0]!.fixture));
    const bare: ChannelRef = { ...c.channel, credentials: {} };
    const provider = c.name === "meta_cloud" ? new MetaCloudProvider({ graphUrl: "https://graph.test", appSecret: undefined }) : make();
    expect(await provider.verifyWebhook(c.authentic(body), bare)).toBe(false);
  });

  describe("parseWebhook → eventos canônicos válidos", () => {
    for (const item of c.parse) {
      it(item.fixture, async () => {
        const body = JSON.stringify(fixture(item.fixture));
        const events = await make().parseWebhook(c.authentic(body), c.channel);
        expect(events).toHaveLength(item.expected.length);
        events.forEach((event, i) => {
          expect(inboundEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
          expect(event).toMatchObject(item.expected[i]!);
        });
      });
    }

    it("corpo que não é JSON não derruba o parse", async () => {
      expect(await make().parseWebhook(c.authentic("isto não é json"), c.channel)).toEqual([]);
    });
  });

  it("envia texto e devolve o id do provedor", async () => {
    const { fetch, calls } = fakeFetch(() => c.sendOk.clone());
    const result = await make(fetch).send(c.channel, text("ext-1"));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/^https?:\/\//);
    // o destino vai só com dígitos
    expect(String(calls[0]!.init?.body)).toContain("5567999990000");
  });

  it("traduz limite de taxa, queda de rede e erro do provedor sem lançar nem vazar segredo", async () => {
    const limited = await make(fakeFetch(() => c.sendRateLimited.clone()).fetch).send(c.channel, text("ext-2"));
    expect(limited).toMatchObject({ ok: false, code: "rate_limited" });

    const down = await make(async () => {
      throw new Error("ECONNREFUSED");
    }).send(c.channel, text("ext-3"));
    expect(down).toMatchObject({ ok: false });

    const broken = await make(fakeFetch(() => new Response("boom", { status: 500 })).fetch).send(c.channel, text("ext-4"));
    expect(broken).toMatchObject({ ok: false, code: "unknown" });

    for (const result of [limited, down, broken]) {
      for (const secret of c.secrets) expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it("recusa texto vazio e mídia sem arquivo", async () => {
    const provider = make();
    expect(await provider.send(c.channel, { externalId: "e", to: "+5567999990000", kind: "text" })).toMatchObject({ ok: false, code: "rejected" });
    expect(await provider.send(c.channel, { externalId: "e", to: "+5567999990000", kind: "image" })).toMatchObject({ ok: false, code: "rejected" });
  });

  it("modelo (template): só quem declara suporte envia", async () => {
    const { fetch, calls } = fakeFetch(() => c.sendOk.clone());
    const provider = make(fetch);
    const result = await provider.send(c.channel, {
      externalId: "tpl-1",
      to: "+5567999990000",
      kind: "template",
      template: { name: "lembrete_consulta", language: "pt_BR", bodyParams: ["Maria", "amanhã 14h"] },
    });
    if (provider.capabilities().templates) {
      expect(result.ok).toBe(true);
      const sent = JSON.parse(String(calls[0]!.init?.body)) as { type: string; template: { name: string; components: unknown[] } };
      expect(sent.type).toBe("template");
      expect(sent.template.name).toBe("lembrete_consulta");
      expect(sent.template.components).toHaveLength(1);
    } else {
      expect(result).toMatchObject({ ok: false, code: "rejected" });
      expect(calls).toHaveLength(0);
    }
  });
});

describe("contrato do provedor: instagram (só estado de conexão)", () => {
  const provider = new InstagramProvider();
  const channel: ChannelRef = { id: "c3", organizationId: "org_a", credentials: {} };

  it("fica aguardando autorização e deixa claro que o envio não existe", async () => {
    expect(provider.kind).toBe("instagram");
    expect(await provider.connect(channel)).toEqual({ status: "awaiting_authorization" });
    expect(await provider.status(channel)).toBe("awaiting_authorization");
    expect(await provider.status({ ...channel, address: "@casa" })).toBe("connected");
    const sent = await provider.send(channel, text("ig-1"));
    expect(sent).toMatchObject({ ok: false, code: "rejected" });
    expect(sent.ok ? "" : sent.message).toMatch(/ainda não/i);
  });

  it("falha fechada no webhook e não interpreta nada", async () => {
    const request = post({}, "{}");
    expect(await provider.verifyWebhook(request, channel)).toBe(false);
    expect(await provider.parseWebhook(request, channel)).toEqual([]);
    expect(provider.capabilities().media).toBe(false);
    expect(provider.capabilities().presence).toBe(false);
    expect((provider as MessagingProvider).sendPresence).toBeUndefined();
  });
});
