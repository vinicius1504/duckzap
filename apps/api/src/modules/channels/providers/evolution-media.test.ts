import { describe, expect, it } from "vitest";
import { outboundMessageSchema, ProviderError, type ChannelRef } from "../../../lib/messaging";
import { EvolutionProvider } from "./evolution";
import type { FetchLike } from "./shared";

/** Mídia no adaptador da Evolution: formato exato dos pedidos de envio (URL e base64) e do download da mídia recebida. */

const channel: ChannelRef = {
  id: "c1",
  organizationId: "org_a",
  credentials: { instanceName: "dz-test-instance", webhookSecret: "dzes_secret_value_123", instanceToken: "INSTANCE-TOKEN-0001" },
  webhookUrl: "https://api.example.com/v1/webhooks/wa/evolution/dzwh_token",
};

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | undefined };
function setup(respond: (call: Call) => Response) {
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
  const provider = new EvolutionProvider({ baseUrl: "http://evolution.test", apiKey: "GLOBAL-KEY-0001", fetch, sleep: async () => {} });
  return { provider, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const sentOk = () => json({ key: { id: "WAMSG1" } }, 201);

const BASE64 = Buffer.from("conteudo-do-arquivo").toString("base64");

describe("Evolution: capacidades", () => {
  it("aceita mídia por base64 e sabe baixar mídia recebida", () => {
    const { provider } = setup(() => sentOk());
    expect(provider.capabilities()).toMatchObject({ media: true, mediaBase64: true, downloadMedia: true });
  });
});

describe("Evolution: envio de mídia", () => {
  it("imagem por URL: sendMedia com mediatype, media, caption e fileName (sem mimetype)", async () => {
    const { provider, calls } = setup(() => sentOk());
    const result = await provider.send(channel, { externalId: "e1", to: "+55 67 99999-0000", kind: "image", mediaUrl: "https://cdn.example.com/a.png?sig=1", text: "Olha só", filename: "foto.png" });
    expect(result).toEqual({ ok: true, providerMessageId: "WAMSG1" });
    expect(calls[0]!.url).toBe("http://evolution.test/message/sendMedia/dz-test-instance");
    expect(calls[0]!.headers.apikey).toBe("INSTANCE-TOKEN-0001");
    expect(calls[0]!.body).toEqual({ number: "5567999990000", mediatype: "image", media: "https://cdn.example.com/a.png?sig=1", caption: "Olha só", fileName: "foto.png" });
  });

  it("documento por BASE64: media é o base64 puro, com fileName e mimetype", async () => {
    const { provider, calls } = setup(() => sentOk());
    const result = await provider.send(channel, {
      externalId: "e2",
      to: "5567999990000",
      kind: "document",
      mediaBase64: BASE64,
      mimeType: "application/pdf",
      filename: "Proposta.pdf",
    });
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe("http://evolution.test/message/sendMedia/dz-test-instance");
    expect(calls[0]!.body).toEqual({ number: "5567999990000", mediatype: "document", media: BASE64, mimetype: "application/pdf", fileName: "Proposta.pdf" });
  });

  it("base64 sem nome de arquivo é recusado antes de chamar a Evolution (ela exige fileName)", async () => {
    const { provider, calls } = setup(() => sentOk());
    const result = await provider.send(channel, { externalId: "e3", to: "5567999990000", kind: "image", mediaBase64: BASE64, mimeType: "image/png" });
    expect(result).toMatchObject({ ok: false, code: "rejected" });
    expect(calls).toHaveLength(0);
  });

  it("áudio (URL ou base64): sendWhatsAppAudio com encoding, para a Evolution converter em mensagem de voz", async () => {
    const { provider, calls } = setup(() => sentOk());
    await provider.send(channel, { externalId: "e4", to: "5567999990000", kind: "audio", mediaBase64: BASE64, mimeType: "audio/webm", filename: "gravacao.webm" });
    await provider.send(channel, { externalId: "e5", to: "5567999990000", kind: "audio", mediaUrl: "https://cdn.example.com/a.webm" });
    expect(calls[0]!.url).toBe("http://evolution.test/message/sendWhatsAppAudio/dz-test-instance");
    expect(calls[0]!.body).toEqual({ number: "5567999990000", audio: BASE64, encoding: true });
    expect(calls[1]!.body).toEqual({ number: "5567999990000", audio: "https://cdn.example.com/a.webm", encoding: true });
  });

  it("sem arquivo nenhum: recusa", async () => {
    const { provider } = setup(() => sentOk());
    expect(await provider.send(channel, { externalId: "e6", to: "5567999990000", kind: "audio" })).toMatchObject({ ok: false, code: "rejected" });
    expect(await provider.send(channel, { externalId: "e7", to: "5567999990000", kind: "document", filename: "a.pdf" })).toMatchObject({ ok: false, code: "rejected" });
  });

  it("o schema de saída aceita base64 grande (até ~22 MB de arquivo) e recusa acima do teto", () => {
    const base = { externalId: "e", to: "5567999990000", kind: "document" as const, filename: "a.pdf" };
    expect(outboundMessageSchema.safeParse({ ...base, mediaBase64: "A".repeat(28_000_000) }).success).toBe(true);
    expect(outboundMessageSchema.safeParse({ ...base, mediaBase64: "A".repeat(30_000_001) }).success).toBe(false);
  });
});

describe("Evolution: downloadMedia (mídia recebida)", () => {
  const ok = (over: Record<string, unknown> = {}) => json({ mediaType: "imageMessage", fileName: "ABC.jpeg", mimetype: "image/jpeg", size: { fileLength: 19 }, base64: BASE64, buffer: null, ...over }, 201);

  it("POST /chat/getBase64FromMediaMessage/{instância} com { message: { key: { id } } } e a chave da instância", async () => {
    const { provider, calls } = setup(() => ok());
    const media = await provider.downloadMedia!(channel, { externalId: "3EB0ABC", maxBytes: 1000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://evolution.test/chat/getBase64FromMediaMessage/dz-test-instance");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.apikey).toBe("INSTANCE-TOKEN-0001");
    expect(calls[0]!.body).toEqual({ message: { key: { id: "3EB0ABC" } }, convertToMp4: false });
    expect(media.bytes.toString()).toBe("conteudo-do-arquivo");
    expect(media).toMatchObject({ mimeType: "image/jpeg", fileName: "ABC.jpeg" });
  });

  it("recusa antes de decodificar quando o base64 passa do limite", async () => {
    const { provider } = setup(() => ok({ base64: "A".repeat(4000) }));
    const error = await provider.downloadMedia!(channel, { externalId: "x", maxBytes: 1000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("rejected");
  });

  it("recusa pelo Content-Length, sem ler o corpo inteiro", async () => {
    const { provider } = setup(() => json({ base64: BASE64 }, 201, { "content-length": "999999999" }));
    const error = await provider.downloadMedia!(channel, { externalId: "x", maxBytes: 1000 }).catch((e: unknown) => e);
    expect((error as ProviderError).code).toBe("rejected");
  });

  it("traduz falhas em ProviderError (sem vazar a chave): 400 mensagem não achada, 401, 5xx, resposta sem base64", async () => {
    for (const [status, body, code] of [
      [400, { error: "Bad Request", response: { message: "Message not found" } }, "rejected"],
      [401, { error: "x" }, "invalid_credentials"],
      [500, { error: "x" }, "unavailable"],
      [201, { mediaType: "imageMessage" }, "rejected"],
    ] as const) {
      const { provider } = setup(() => json(body, status));
      const error = await provider.downloadMedia!(channel, { externalId: "x", maxBytes: 1000 }).catch((e: unknown) => e);
      expect(error, `${status}`).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe(code);
      expect((error as ProviderError).message).not.toContain("INSTANCE-TOKEN");
    }
  });

  it("rede fora do ar vira ProviderError('unavailable')", async () => {
    const provider = new EvolutionProvider({
      baseUrl: "http://evolution.test",
      apiKey: "k",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const error = await provider.downloadMedia!(channel, { externalId: "x", maxBytes: 1000 }).catch((e: unknown) => e);
    expect((error as ProviderError).code).toBe("unavailable");
  });
});
