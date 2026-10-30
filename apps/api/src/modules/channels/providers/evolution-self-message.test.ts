import { describe, expect, it } from "vitest";
import { inboundEventSchema, type ChannelRef } from "../../../lib/messaging";
import { EvolutionProvider } from "./evolution";
import type { FetchLike } from "./shared";

/** Mensagem que SAIU da conta (digitada no celular ou eco do que o DuckChat enviou): `key.fromMe = true` no messages.upsert. */

const channel: ChannelRef = {
  id: "c1",
  organizationId: "org_a",
  credentials: { instanceName: "dz-test-instance", webhookSecret: "dzes_secret_value_123", instanceToken: "INSTANCE-TOKEN-0001" },
  webhookUrl: "https://api.example.com/v1/webhooks/wa/evolution/dzwh_token",
};

const fetch: FetchLike = async () => new Response("{}", { status: 200 });
const provider = new EvolutionProvider({ baseUrl: "http://evolution.test", apiKey: "GLOBAL-KEY-0001", fetch, sleep: async () => {}, now: () => new Date("2026-10-27T14:00:00Z") });

const chat = "5567999990000@s.whatsapp.net";
const upsert = (data: Record<string, unknown>) =>
  provider.parseWebhook(new Request("https://x.test/", { method: "POST", body: JSON.stringify({ event: "messages.upsert", instance: "dz-test-instance", data }) }), channel);

describe("Evolution: messages.upsert com fromMe", () => {
  it("texto digitado no celular vira evento marcado fromMe, com o endereço do CLIENTE e sem nome", async () => {
    const events = await upsert({
      key: { remoteJid: chat, fromMe: true, id: "3EB0PHONE1" },
      pushName: "Marina (dona da conta)",
      message: { conversation: "Oi! Já separei o seu pedido." },
      messageTimestamp: 1793052600,
    });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({ type: "message", externalId: "3EB0PHONE1", from: "+5567999990000", kind: "text", text: "Oi! Já separei o seu pedido.", fromMe: true });
    // o pushName de uma mensagem nossa é o do dono da conta: nunca pode virar o nome do cliente
    expect(event).not.toHaveProperty("name");
    // o marcador sobrevive à validação do evento gravado (z.object descarta chave desconhecida em silêncio)
    const stored = inboundEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(stored).toMatchObject({ fromMe: true });
  });

  it("imagem, áudio e documento nossos também entram (com a referência da mídia)", async () => {
    const image = await upsert({ key: { remoteJid: chat, fromMe: true, id: "IMG1" }, message: { imageMessage: { caption: "foto" } } });
    const audio = await upsert({ key: { remoteJid: chat, fromMe: true, id: "AUD1" }, message: { audioMessage: { seconds: 4, ptt: true } } });
    const doc = await upsert({ key: { remoteJid: chat, fromMe: true, id: "DOC1" }, message: { documentMessage: { caption: "contrato" } } });
    expect(image[0]).toMatchObject({ kind: "image", text: "foto", mediaRef: "IMG1", fromMe: true });
    expect(audio[0]).toMatchObject({ kind: "audio", mediaRef: "AUD1", fromMe: true });
    expect(doc[0]).toMatchObject({ kind: "document", text: "contrato", mediaRef: "DOC1", fromMe: true });
  });

  it("mensagem técnica nossa (reação, apagar, chaves) é descartada: não vira '[tipo de mensagem não suportado]'", async () => {
    expect(await upsert({ key: { remoteJid: chat, fromMe: true, id: "R1" }, message: { reactionMessage: { text: "👍" } } })).toEqual([]);
    expect(await upsert({ key: { remoteJid: chat, fromMe: true, id: "P1" }, message: { protocolMessage: { type: 0 } } })).toEqual([]);
    expect(await upsert({ key: { remoteJid: chat, fromMe: true, id: "S1" }, message: { senderKeyDistributionMessage: {} } })).toEqual([]);
  });

  it("grupo e transmissão continuam ignorados, também quando a mensagem é nossa", async () => {
    expect(await upsert({ key: { remoteJid: "120363000000000000@g.us", fromMe: true, id: "G1" }, message: { conversation: "oi grupo" } })).toEqual([]);
    expect(await upsert({ key: { remoteJid: "status@broadcast", fromMe: true, id: "B1" }, message: { conversation: "status" } })).toEqual([]);
  });

  it("mensagem do cliente segue igual: sem fromMe e com o nome do contato", async () => {
    const [event] = await upsert({ key: { remoteJid: chat, fromMe: false, id: "IN1" }, pushName: "Cliente Silva", message: { conversation: "oi" }, messageTimestamp: 1793052600 });
    expect(event).toMatchObject({ type: "message", externalId: "IN1", name: "Cliente Silva", kind: "text" });
    expect(event).not.toHaveProperty("fromMe");
  });
});
