import {
  MAX_PRESENCE_MS,
  MAX_TYPING_MS,
  ProviderError,
  type ChannelRef,
  type ConnectResult,
  type ConnectionStatus,
  type DownloadedMedia,
  type InboundEvent,
  type InboundPresence,
  type MessagingProvider,
  type OutboundMessage,
  type OutboundPresence,
  type ProviderContact,
  type ProviderCapabilities,
  type SendResult,
} from "../../../lib/messaging";
import {
  asRecord,
  asString,
  isoFromSeconds,
  readBody,
  safeCompare,
  sleep,
  toDigits,
  toE164,
  type FetchLike,
  type Inspect,
} from "./shared";

/** Cabeçalho que a Evolution devolve em cada webhook (configurado em `webhook.headers`). */
export const EVOLUTION_WEBHOOK_HEADER = "x-duckzap-key";

/** A lista de contatos tem milhares de itens: prazo maior que o das outras chamadas (20 s). */
const CONTACTS_TIMEOUT_MS = 60_000;

const WEBHOOK_EVENTS = ["QRCODE_UPDATED", "CONNECTION_UPDATE", "MESSAGES_UPSERT", "MESSAGES_UPDATE"];
/** Evento extra pedido quando a presença está ligada (`PRESENCE_ENABLED`): o contato digitando/gravando. */
export const PRESENCE_WEBHOOK_EVENT = "PRESENCE_UPDATE";

const INBOUND_PRESENCES: ReadonlySet<string> = new Set<InboundPresence>(["composing", "recording", "paused", "available", "unavailable"]);

export type EvolutionOptions = {
  baseUrl: string;
  /** Chave global (AUTHENTICATION_API_KEY): criar/apagar instâncias. */
  apiKey: string | undefined;
  fetch?: FetchLike;
  /** Pausa entre tentativas de obter o QR (injetável nos testes). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** `PRESENCE_ENABLED` (padrão true). false: sem capacidade `presence`, sem pedir `PRESENCE_UPDATE`, sem `delay` no envio. */
  presenceEnabled?: boolean;
};

type Reply = { response: Response; body: Record<string, unknown>; raw: unknown };

/**
 * Adaptador da Evolution API v2.3 (Baileys, não oficial — §3.6).
 * Credenciais do canal: `instanceName` (gerado por nós), `webhookSecret` (gerado por nós, devolvido pela Evolution
 * no cabeçalho do webhook) e `instanceToken` (devolvido pela Evolution ao criar a instância, usado no envio).
 */
export class EvolutionProvider implements MessagingProvider {
  readonly kind = "evolution";
  private readonly http: FetchLike;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly presenceEnabled: boolean;

  constructor(private readonly options: EvolutionOptions) {
    this.presenceEnabled = options.presenceEnabled ?? true;
    this.http = options.fetch ?? ((input, init) => fetch(input, init));
    this.wait = options.sleep ?? sleep;
    this.now = options.now ?? (() => new Date());
  }

  capabilities(): ProviderCapabilities {
    // botões/listas são instáveis no Baileys (§3.6): degradar para texto numerado
    return { buttons: false, lists: false, templates: false, media: true, reactions: true, window24h: false, presence: this.presenceEnabled, mediaBase64: true, downloadMedia: true };
  }

  // --- HTTP ---------------------------------------------------------------------------------------------

  private async call(path: string, init: { method?: string; body?: unknown; key: string; timeoutMs?: number; maxResponseBytes?: number }): Promise<Reply> {
    let response: Response;
    try {
      response = await this.http(`${this.options.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: { apikey: init.key, "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
      });
    } catch {
      throw new ProviderError("unavailable", "Não conseguimos falar com o serviço de QR Code. Tente de novo em instantes.");
    }
    // resposta enorme (mídia): recusa pelo cabeçalho ANTES de ler tudo para a memória
    const declared = Number(response.headers.get("content-length"));
    if (init.maxResponseBytes !== undefined && Number.isFinite(declared) && declared > init.maxResponseBytes) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError("rejected", "O arquivo recebido é grande demais.");
    }
    const raw = await readBody(response);
    return { response, body: asRecord(raw), raw };
  }

  private globalKey() {
    if (!this.options.apiKey) throw new ProviderError("not_configured", "O provedor de QR Code não está configurado.");
    return this.options.apiKey;
  }

  /** Token da instância quando já existe (menor privilégio); senão a chave global. */
  private instanceKey(channel: ChannelRef) {
    return channel.credentials.instanceToken ?? this.globalKey();
  }

  private name(channel: ChannelRef) {
    const name = channel.credentials.instanceName;
    if (!name) throw new ProviderError("not_configured", "Canal sem instância no provedor.");
    return name;
  }

  private webhookConfig(channel: ChannelRef) {
    if (!channel.webhookUrl) throw new ProviderError("not_configured", "URL de webhook ausente.");
    return {
      enabled: true,
      url: channel.webhookUrl,
      webhookByEvents: false,
      webhookBase64: false,
      headers: { [EVOLUTION_WEBHOOK_HEADER]: channel.credentials.webhookSecret ?? "" },
      events: this.webhookEvents(),
    };
  }

  private webhookEvents() {
    return this.presenceEnabled ? [...WEBHOOK_EVENTS, PRESENCE_WEBHOOK_EVENT] : WEBHOOK_EVENTS;
  }

  // --- connect / status ---------------------------------------------------------------------------------

  async connect(channel: ChannelRef): Promise<ConnectResult> {
    const name = this.name(channel);
    const key = this.globalKey();
    const path = `/instance/connect/${encodeURIComponent(name)}`;
    let credentials: Record<string, string> | undefined;

    let first = await this.call(path, { key });
    let body = first.body;
    if (first.response.status === 404) {
      const created = await this.call("/instance/create", {
        method: "POST",
        key,
        body: { instanceName: name, integration: "WHATSAPP-BAILEYS", qrcode: true, webhook: this.webhookConfig(channel) },
      });
      if (!created.response.ok) throw new ProviderError("unavailable", "Não foi possível criar a conexão QR Code.");
      const token = asString(created.body.hash);
      if (token) credentials = { instanceToken: token };
      const qrcode = asRecord(created.body.qrcode);
      body = { code: qrcode.code, pairingCode: qrcode.pairingCode };
    } else if (!first.response.ok) {
      throw new ProviderError("unavailable", "Não foi possível gerar o QR Code agora.");
    }

    // já conectada? então não há QR
    if ((await this.connectionState(name, key)) === "connected") {
      const info = await this.inspect({ ...channel, credentials: { ...channel.credentials, ...credentials } });
      return { status: "connected", address: info.address, credentials };
    }

    // o QR pode demorar alguns segundos para nascer: tenta de novo antes de desistir
    let code = asString(body.code);
    for (let attempt = 0; !code && attempt < 3; attempt++) {
      await this.wait(1000);
      first = await this.call(path, { key });
      body = first.body;
      code = asString(body.code);
    }
    return { status: "qr_pending", qrCode: code, pairingCode: asString(body.pairingCode), credentials };
  }

  private async connectionState(name: string, key: string): Promise<ConnectionStatus> {
    const { response, body } = await this.call(`/instance/connectionState/${encodeURIComponent(name)}`, { key });
    if (response.status === 404) return "disconnected";
    if (!response.ok) throw new ProviderError("unavailable", "Não conseguimos consultar o status da conexão.");
    return mapEvolutionState(asString(asRecord(body.instance).state));
  }

  async status(channel: ChannelRef): Promise<ConnectionStatus> {
    return (await this.inspect(channel)).status;
  }

  async inspect(channel: ChannelRef): Promise<Inspect> {
    const name = this.name(channel);
    const key = this.globalKey();
    const status = await this.connectionState(name, key);
    if (status !== "connected") return { status };
    const { raw } = await this.call(`/instance/fetchInstances?instanceName=${encodeURIComponent(name)}`, { key });
    const first = Array.isArray(raw) ? asRecord(raw[0]) : {};
    const owner = asString(first.ownerJid) ?? asString(first.number);
    return { status, address: toE164(owner?.split("@")[0]) };
  }

  /** Sai da conta e apaga a instância (reconectar cria outra). Erros 4xx (já desconectada/inexistente) são aceitos. */
  async disconnect(channel: ChannelRef): Promise<void> {
    const name = encodeURIComponent(this.name(channel));
    const key = this.globalKey();
    const logout = await this.call(`/instance/logout/${name}`, { method: "DELETE", key });
    if (logout.response.status >= 500) throw new ProviderError("unavailable", "Não foi possível desconectar agora.");
    const removed = await this.call(`/instance/delete/${name}`, { method: "DELETE", key });
    if (removed.response.status >= 500) throw new ProviderError("unavailable", "Não foi possível desconectar agora.");
  }

  async updateWebhook(channel: ChannelRef): Promise<void> {
    const { response } = await this.call(`/webhook/set/${encodeURIComponent(this.name(channel))}`, {
      method: "POST",
      key: this.globalKey(),
      body: { webhook: this.webhookConfig(channel) },
    });
    if (!response.ok) throw new ProviderError("unavailable", "Não foi possível atualizar o endereço de recebimento.");
  }

  /**
   * Confere o webhook da instância (`GET /webhook/find/{instância}`) e só o reaplica (`updateWebhook`) se estiver
   * desligado, apontando para outra URL ou sem algum dos eventos de hoje (ex.: `PRESENCE_UPDATE` em instância antiga).
   */
  async syncWebhook(channel: ChannelRef): Promise<"updated" | "unchanged"> {
    if (!channel.webhookUrl) throw new ProviderError("not_configured", "URL de webhook ausente.");
    const found = await this.call(`/webhook/find/${encodeURIComponent(this.name(channel))}`, { key: this.globalKey() });
    if (found.response.ok) {
      const events = Array.isArray(found.body.events) ? found.body.events : [];
      const complete = this.webhookEvents().every((event) => events.includes(event));
      if (found.body.enabled === true && found.body.url === channel.webhookUrl && complete) return "unchanged";
    }
    await this.updateWebhook(channel);
    return "updated";
  }

  // --- presença -----------------------------------------------------------------------------------------

  /**
   * `POST /chat/sendPresence/{instância}` com `{ number, presence, delay }` (os três obrigatórios). A Evolution confere se o
   * número existe no WhatsApp, assina a presença do contato, mostra `presence` por `delay` ms e então envia `paused`;
   * a resposta só volta ao fim do `delay`. Quem chama NÃO deve esperar por isso na requisição do usuário.
   */
  async sendPresence(channel: ChannelRef, input: { to: string; presence: OutboundPresence; durationMs: number }): Promise<void> {
    if (!this.presenceEnabled) return;
    const number = toDigits(input.to);
    if (number.length < 8) throw new ProviderError("rejected", "Número inválido para presença.");
    const delay = Math.min(MAX_PRESENCE_MS, Math.max(1, Math.round(input.durationMs)));
    const { response } = await this.call(`/chat/sendPresence/${encodeURIComponent(this.name(channel))}`, {
      method: "POST",
      key: this.instanceKey(channel),
      body: { number, presence: input.presence, delay },
    });
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) throw new ProviderError("invalid_credentials", "O número está desconectado.");
    throw new ProviderError(response.status === 429 || response.status >= 500 ? "unavailable" : "rejected", "O provedor não aceitou a presença.");
  }

  // --- contatos -----------------------------------------------------------------------------------------

  /**
   * `POST /chat/findContacts/{instância}` com `{ where: {} }`: tudo o que a instância conhece (pessoas, grupos, IDs ocultos).
   * A resposta é grande (milhares de itens), então o prazo é maior que o das outras chamadas. Os campos `isSaved`/`type` da
   * Evolution vêm iguais para todos (não distinguem agenda de conversa) e por isso não entram na classificação.
   */
  async listContacts(channel: ChannelRef): Promise<ProviderContact[]> {
    const { response, raw } = await this.call(`/chat/findContacts/${encodeURIComponent(this.name(channel))}`, {
      method: "POST",
      key: this.instanceKey(channel),
      body: { where: {} },
      timeoutMs: CONTACTS_TIMEOUT_MS,
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new ProviderError("invalid_credentials", "O número está desconectado.");
    }
    if (!response.ok) {
      throw new ProviderError(response.status === 429 || response.status >= 500 ? "unavailable" : "rejected", "O provedor não devolveu os contatos.");
    }
    if (!Array.isArray(raw)) throw new ProviderError("unavailable", "O provedor devolveu uma resposta inesperada.");
    return raw.map(classifyEvolutionContact);
  }

  // --- envio --------------------------------------------------------------------------------------------

  async send(channel: ChannelRef, message: OutboundMessage): Promise<SendResult> {
    const name = encodeURIComponent(this.name(channel));
    const number = toDigits(message.to);
    // `delay` é nativo da Evolution: ela mostra "digitando…" por esse tempo e SÓ ENTÃO entrega (a resposta demora o mesmo)
    const delay = this.presenceEnabled && message.typingMs ? { delay: Math.min(MAX_TYPING_MS, Math.round(message.typingMs)) } : {};
    let path: string;
    let body: Record<string, unknown>;
    switch (message.kind) {
      case "text":
        if (!message.text) return { ok: false, code: "rejected", message: "Mensagem de texto vazia." };
        path = `/message/sendText/${name}`;
        body = { number, text: message.text, ...delay };
        break;
      case "audio": {
        // URL ou base64 puro: a Evolution converte QUALQUER formato (webm/opus do navegador, mp3, m4a) para ogg/opus com o
        // ffmpeg dela (`encoding`) e envia como mensagem de voz tocável (ptt)
        const audio = message.mediaUrl ?? message.mediaBase64;
        if (!audio) return { ok: false, code: "rejected", message: "Áudio sem arquivo." };
        path = `/message/sendWhatsAppAudio/${name}`;
        body = { number, audio, encoding: true };
        break;
      }
      case "image":
      case "document": {
        const media = message.mediaUrl ?? message.mediaBase64;
        if (!media) return { ok: false, code: "rejected", message: "Mídia sem arquivo." };
        // por base64 a Evolution exige `fileName` (documento) e deduz o tipo pela extensão dele
        if (!message.mediaUrl && !message.filename) return { ok: false, code: "rejected", message: "Mídia sem nome de arquivo." };
        path = `/message/sendMedia/${name}`;
        body = {
          number,
          mediatype: message.kind,
          media,
          ...(!message.mediaUrl && message.mimeType ? { mimetype: message.mimeType } : {}),
          ...(message.text ? { caption: message.text } : {}),
          ...(message.filename ? { fileName: message.filename } : {}),
          ...delay,
        };
        break;
      }
      case "template":
        return { ok: false, code: "rejected", message: "Modelos de mensagem só existem na API oficial." };
    }
    let reply: Reply;
    try {
      reply = await this.call(path, { method: "POST", key: this.instanceKey(channel), body });
    } catch (error) {
      if (error instanceof ProviderError) {
        return { ok: false, code: error.code === "unavailable" ? "unknown" : "rejected", message: error.message };
      }
      throw error;
    }
    const { response, body: payload } = reply;
    if (response.ok) {
      const id = asString(asRecord(payload.key).id);
      return id ? { ok: true, providerMessageId: id } : { ok: false, code: "unknown", message: "O provedor não confirmou o envio." };
    }
    if (response.status === 429) return { ok: false, code: "rate_limited", message: "Limite de envio do provedor atingido." };
    if (response.status === 401 || response.status === 403) return { ok: false, code: "disconnected", message: "O número está desconectado." };
    if (response.status >= 500) return { ok: false, code: "unknown", message: "O provedor falhou ao enviar." };
    return { ok: false, code: "rejected", message: "O provedor recusou a mensagem." };
  }

  // --- mídia recebida -----------------------------------------------------------------------------------

  /**
   * `POST /chat/getBase64FromMediaMessage/{instância}` com `{ message: { key: { id } } }` (Evolution 2.3.x; responde 201 com
   * `{ mediaType, fileName, mimetype, size, base64 }`). ATENÇÃO: a Evolution procura a mensagem no banco dela, então o container
   * precisa de `DATABASE_SAVE_DATA_NEW_MESSAGE=true`; sem isso responde 400 "Message not found" e a mídia fica indisponível.
   * O corpo é limitado ANTES de decodificar (`maxBytes`); conteúdo do cliente nunca vai para log.
   */
  async downloadMedia(channel: ChannelRef, input: { externalId: string; maxBytes: number; timeoutMs?: number }): Promise<DownloadedMedia> {
    const { response, body } = await this.call(`/chat/getBase64FromMediaMessage/${encodeURIComponent(this.name(channel))}`, {
      method: "POST",
      key: this.instanceKey(channel),
      body: { message: { key: { id: input.externalId } }, convertToMp4: false },
      timeoutMs: input.timeoutMs ?? 20_000,
      // base64 + JSON: ~4/3 do arquivo
      maxResponseBytes: Math.ceil((input.maxBytes * 4) / 3) + 4096,
    });
    if (response.status === 401 || response.status === 403) throw new ProviderError("invalid_credentials", "O número está desconectado.");
    if (!response.ok) {
      throw new ProviderError(response.status === 429 || response.status >= 500 ? "unavailable" : "rejected", "O provedor não devolveu o arquivo.");
    }
    const base64 = asString(body.base64);
    if (!base64) throw new ProviderError("rejected", "O provedor não devolveu o arquivo.");
    // 4 caracteres de base64 = 3 bytes
    if ((base64.length * 3) / 4 > input.maxBytes + 4) throw new ProviderError("rejected", "O arquivo recebido é grande demais.");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > input.maxBytes) throw new ProviderError("rejected", "O arquivo recebido é grande demais.");
    return { bytes, mimeType: asString(body.mimetype), fileName: asString(body.fileName) };
  }

  // --- webhook ------------------------------------------------------------------------------------------

  async verifyWebhook(request: Request, channel: ChannelRef): Promise<boolean> {
    const secret = channel.credentials.webhookSecret;
    const received = request.headers.get(EVOLUTION_WEBHOOK_HEADER);
    if (!secret || !received || !safeCompare(received, secret)) return false;
    // a instância citada no corpo precisa ser a deste canal (defesa em profundidade)
    const body = asRecord(await request.clone().json().catch(() => null));
    return asString(body.instance) === channel.credentials.instanceName;
  }

  async parseWebhook(request: Request, _channel: ChannelRef): Promise<InboundEvent[]> {
    const payload = asRecord(await request.clone().json().catch(() => null));
    const event = asString(payload.event)?.toLowerCase().replace(/_/g, ".");
    const data = asRecord(payload.data);
    const fallbackAt = parseDate(asString(payload.date_time)) ?? this.now();

    switch (event) {
      case "messages.upsert": {
        const parsed = parseUpsert(data, fallbackAt);
        return parsed ? [parsed] : [];
      }
      case "messages.update": {
        const parsed = parseUpdate(data, fallbackAt);
        return parsed ? [parsed] : [];
      }
      case "connection.update": {
        const reason = typeof data.statusReason === "number" ? data.statusReason : undefined;
        // 403 do WhatsApp = conta restrita/banida (heurística, ver relatório)
        const status: ConnectionStatus = reason === 403 ? "banned" : mapEvolutionState(asString(data.state));
        return [{ type: "connection", status, at: fallbackAt.toISOString() }];
      }
      case "presence.update":
        return this.presenceEnabled ? parsePresence(data, fallbackAt) : [];
      case "qrcode.updated": {
        const qrcode = asRecord(data.qrcode);
        const code = asString(qrcode.code);
        if (!code) return [];
        return [{ type: "connection", status: "qr_pending", qrCode: code, pairingCode: asString(qrcode.pairingCode), at: fallbackAt.toISOString() }];
      }
      default:
        return [];
    }
  }
}

function mapEvolutionState(state: string | undefined): ConnectionStatus {
  switch (state) {
    case "open":
      return "connected";
    case "connecting":
      return "qr_pending";
    default:
      return "disconnected";
  }
}

/** Nome vazio ou só com dígitos e símbolos de telefone não é um nome útil (o WhatsApp usa o próprio número). */
const PHONE_LIKE = /^[\d\s+()\-.]*$/;
// marcas de direção e espaços especiais que o WhatsApp põe em volta de números formatados
const INVISIBLE = /[​-‏‪-‮⁦-⁩ ﻿]/g;

/** `item` de `findContacts` → contato canônico. Nunca lança: item estranho vira `other`. Sem logs (dado pessoal). */
export function classifyEvolutionContact(item: unknown): ProviderContact {
  const record = asRecord(item);
  const jid = asString(record.remoteJid) ?? "";
  const pushName = asString(record.pushName)?.replace(INVISIBLE, " ").trim() ?? "";
  const name = pushName && !PHONE_LIKE.test(pushName) ? pushName : null;
  const [user = "", server = ""] = jid.split("@");
  if (server === "g.us") return { jid, kind: "group", phoneDigits: null, name };
  if (server === "lid") return { jid, kind: "hidden", phoneDigits: null, name };
  if (server === "s.whatsapp.net") {
    const digits = (user.split(":")[0] ?? "").replace(/\D/g, "");
    if (/^\d{8,15}$/.test(digits) && !/^0+$/.test(digits)) return { jid, kind: "person", phoneDigits: digits, name };
  }
  return { jid, kind: "other", phoneDigits: null, name };
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `5567999990000@s.whatsapp.net` → `+5567999990000`; grupos e transmissões são ignorados. */
function jidToAddress(jid: string | undefined, alt?: string): string | undefined {
  for (const candidate of [jid, alt]) {
    if (!candidate) continue;
    const [user, server] = candidate.split("@");
    if (server === "s.whatsapp.net") return toE164(user);
  }
  return undefined;
}

/**
 * `data = { id: <jid do chat>, presences: { "<jid>": { lastKnownPresence } } }`. Só conversa 1:1 (`@s.whatsapp.net`); grupo,
 * transmissão e status são ignorados, assim como presença de quem não é o dono do chat e valores desconhecidos.
 */
function parsePresence(data: Record<string, unknown>, at: Date): InboundEvent[] {
  const chat = asString(data.id);
  const [chatUser, chatServer] = chat?.split("@") ?? [];
  if (!chatUser || chatServer !== "s.whatsapp.net") return [];
  const from = toE164(chatUser);
  if (!from) return [];
  const out: InboundEvent[] = [];
  for (const [jid, value] of Object.entries(asRecord(data.presences))) {
    const [user, server] = jid.split("@");
    if (user !== chatUser || server !== "s.whatsapp.net") continue;
    const presence = asString(asRecord(value).lastKnownPresence);
    if (presence && INBOUND_PRESENCES.has(presence)) out.push({ type: "presence", from, presence: presence as InboundPresence, at: at.toISOString() });
  }
  return out;
}

function parseUpsert(data: Record<string, unknown>, fallbackAt: Date): InboundEvent | undefined {
  const key = asRecord(data.key);
  if (key.fromMe === true) return undefined; // eco do que enviamos (o status chega em messages.update)
  const id = asString(key.id);
  const from = jidToAddress(asString(key.remoteJid), asString(key.remoteJidAlt) ?? asString(key.senderPn));
  if (!id || !from) return undefined;

  const message = asRecord(data.message);
  const at = isoFromSeconds(data.messageTimestamp, fallbackAt);
  const name = asString(data.pushName);
  const base = { type: "message" as const, externalId: id, from, ...(name ? { name } : {}), at };

  const text = asString(message.conversation) ?? asString(asRecord(message.extendedTextMessage).text);
  if (text) return { ...base, kind: "text", text };
  const image = asRecord(message.imageMessage);
  if (Object.keys(image).length) return { ...base, kind: "image", text: asString(image.caption), mediaRef: id };
  if (Object.keys(asRecord(message.stickerMessage)).length) return { ...base, kind: "image", sticker: true, mediaRef: id };
  if (Object.keys(asRecord(message.audioMessage)).length) return { ...base, kind: "audio", mediaRef: id };
  const document = asRecord(message.documentMessage);
  if (Object.keys(document).length) return { ...base, kind: "document", text: asString(document.caption), mediaRef: id };
  return { ...base, kind: "other" };
}

function parseUpdate(data: Record<string, unknown>, fallbackAt: Date): InboundEvent | undefined {
  const id = asString(data.keyId) ?? asString(data.messageId);
  if (!id || data.fromMe === false) return undefined; // só status do que NÓS enviamos
  const status = ((): "sent" | "delivered" | "read" | "failed" | undefined => {
    switch (asString(data.status)) {
      case "SERVER_ACK":
        return "sent";
      case "DELIVERY_ACK":
        return "delivered";
      case "READ":
      case "PLAYED":
        return "read";
      case "ERROR":
        return "failed";
      default:
        return undefined;
    }
  })();
  return status ? { type: "status", externalId: id, status, at: fallbackAt.toISOString() } : undefined;
}
