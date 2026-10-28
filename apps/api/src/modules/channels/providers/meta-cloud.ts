import {
  ProviderError,
  type ChannelRef,
  type ConnectResult,
  type ConnectionStatus,
  type InboundEvent,
  type MessagingProvider,
  type OutboundMessage,
  type ProviderCapabilities,
  type SendResult,
} from "../../../lib/messaging";
import {
  asRecord,
  asString,
  hmacSha256Hex,
  isoFromSeconds,
  readBody,
  safeCompare,
  toDigits,
  toE164,
  type FetchLike,
  type Inspect,
} from "./shared";

export const META_SIGNATURE_HEADER = "x-hub-signature-256";
const WINDOW_MS = 24 * 60 * 60 * 1000;

export type MetaCloudOptions = {
  graphUrl: string;
  /** Segredo do app Meta da plataforma; cada canal pode trazer o seu em `credentials.appSecret`. */
  appSecret: string | undefined;
  fetch?: FetchLike;
};

/** Janela de 24 h (§5.4): texto livre só até 24 h depois da última mensagem do cliente. */
export function windowExpiresAt(lastInboundAt: Date | string) {
  return new Date(new Date(lastInboundAt).getTime() + WINDOW_MS);
}
export function isWithin24hWindow(lastInboundAt: Date | string | null | undefined, now: Date = new Date()) {
  if (!lastInboundAt) return false;
  return windowExpiresAt(lastInboundAt).getTime() > now.getTime();
}

/**
 * Handshake `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`.
 * Devolve o `challenge` a ecoar, ou null se o token não confere (timing-safe).
 */
export function metaVerificationChallenge(url: URL, expectedVerifyToken: string | undefined): string | null {
  const params = url.searchParams;
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (params.get("hub.mode") !== "subscribe" || !token || !challenge || !expectedVerifyToken) return null;
  return safeCompare(token, expectedVerifyToken) ? challenge : null;
}

/** Valida `X-Hub-Signature-256: sha256=<hmac do corpo cru com o segredo do app>`. Falha fechada. */
export function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string | undefined): boolean {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  return safeCompare(header.slice("sha256=".length), hmacSha256Hex(appSecret, rawBody));
}

/** Adaptador da WhatsApp Business Cloud API (Meta) — oficial (§3.6). */
export class MetaCloudProvider implements MessagingProvider {
  readonly kind = "meta_cloud";
  private readonly http: FetchLike;

  constructor(private readonly options: MetaCloudOptions) {
    this.http = options.fetch ?? ((input, init) => fetch(input, init));
  }

  capabilities(): ProviderCapabilities {
    return { buttons: true, lists: true, templates: true, media: true, reactions: true, window24h: true, presence: false };
  }

  private async graph(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
    let response: Response;
    try {
      response = await this.http(`${this.options.graphUrl}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ProviderError("unavailable", "Não conseguimos falar com a Meta agora. Tente de novo em instantes.");
    }
    return { response, body: asRecord(await readBody(response)) };
  }

  private credentials(channel: ChannelRef) {
    const { phoneNumberId, accessToken } = channel.credentials;
    if (!phoneNumberId || !accessToken) throw new ProviderError("not_configured", "Canal sem credenciais da API oficial.");
    return { phoneNumberId, accessToken };
  }

  /** Confere o token consultando o número na Graph API. */
  async connect(channel: ChannelRef): Promise<ConnectResult> {
    const info = await this.inspectCredentials(channel);
    if (info.status !== "connected") {
      throw new ProviderError("invalid_credentials", "A Meta recusou o token. Gere um token permanente no Gerenciador de Negócios e tente de novo.");
    }
    return { status: "connected", address: info.address };
  }

  private async inspectCredentials(channel: ChannelRef): Promise<Inspect> {
    const { phoneNumberId, accessToken } = this.credentials(channel);
    const { response, body } = await this.graph(`/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`, accessToken);
    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
      return { status: "disconnected" };
    }
    if (!response.ok) throw new ProviderError("unavailable", "A Meta não respondeu. Tente de novo em instantes.");
    return { status: "connected", address: toE164(asString(body.display_phone_number)) };
  }

  inspect(channel: ChannelRef) {
    return this.inspectCredentials(channel);
  }

  async status(channel: ChannelRef): Promise<ConnectionStatus> {
    return (await this.inspectCredentials(channel)).status;
  }

  /** Não há "logout" na Cloud API: o módulo Canais apaga o token guardado. */
  async disconnect(_channel: ChannelRef): Promise<void> {}

  async send(channel: ChannelRef, message: OutboundMessage): Promise<SendResult> {
    const { phoneNumberId, accessToken } = this.credentials(channel);
    const to = toDigits(message.to);
    const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
    let body: Record<string, unknown>;
    switch (message.kind) {
      case "text":
        if (!message.text) return { ok: false, code: "rejected", message: "Mensagem de texto vazia." };
        body = { ...base, type: "text", text: { body: message.text, preview_url: false } };
        break;
      case "image":
        if (!message.mediaUrl) return { ok: false, code: "rejected", message: "Imagem sem arquivo." };
        body = { ...base, type: "image", image: { link: message.mediaUrl, ...(message.text ? { caption: message.text } : {}) } };
        break;
      case "audio":
        if (!message.mediaUrl) return { ok: false, code: "rejected", message: "Áudio sem arquivo." };
        body = { ...base, type: "audio", audio: { link: message.mediaUrl } };
        break;
      case "document":
        if (!message.mediaUrl) return { ok: false, code: "rejected", message: "Documento sem arquivo." };
        body = {
          ...base,
          type: "document",
          document: {
            link: message.mediaUrl,
            ...(message.text ? { caption: message.text } : {}),
            ...(message.filename ? { filename: message.filename } : {}),
          },
        };
        break;
      case "template": {
        if (!message.template) return { ok: false, code: "rejected", message: "Modelo de mensagem ausente." };
        const params = message.template.bodyParams ?? [];
        body = {
          ...base,
          type: "template",
          template: {
            name: message.template.name,
            language: { code: message.template.language },
            ...(params.length
              ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] }
              : {}),
          },
        };
        break;
      }
    }

    let reply: Awaited<ReturnType<MetaCloudProvider["graph"]>>;
    try {
      reply = await this.graph(`/${encodeURIComponent(phoneNumberId)}/messages`, accessToken, { method: "POST", body });
    } catch (error) {
      if (error instanceof ProviderError) return { ok: false, code: "unknown", message: error.message };
      throw error;
    }
    const { response, body: payload } = reply;
    if (response.ok) {
      const id = asString(asRecord((payload.messages as unknown[] | undefined)?.[0]).id);
      return id ? { ok: true, providerMessageId: id } : { ok: false, code: "unknown", message: "A Meta não confirmou o envio." };
    }
    const error = asRecord(payload.error);
    const code = typeof error.code === "number" ? error.code : undefined;
    if (response.status === 429 || code === 4 || code === 80007 || code === 130429 || code === 131056) {
      return { ok: false, code: "rate_limited", message: "Limite de envio da Meta atingido. Tente de novo em instantes." };
    }
    if (code === 190 || response.status === 401) {
      return { ok: false, code: "disconnected", message: "O token da API oficial expirou ou foi revogado." };
    }
    if (code === 131047) {
      return { ok: false, code: "rejected", message: "Fora da janela de 24 h: só é possível enviar um modelo aprovado." };
    }
    if (response.status >= 500) return { ok: false, code: "unknown", message: "A Meta falhou ao enviar." };
    return { ok: false, code: "rejected", message: "A Meta recusou a mensagem." };
  }

  // --- webhook ------------------------------------------------------------------------------------------

  private appSecret(channel: ChannelRef) {
    return channel.credentials.appSecret ?? this.options.appSecret;
  }

  async verifyWebhook(request: Request, channel: ChannelRef): Promise<boolean> {
    if (request.method === "GET") {
      return metaVerificationChallenge(new URL(request.url), channel.credentials.verifyToken) !== null;
    }
    const raw = await request.clone().text();
    return verifyMetaSignature(raw, request.headers.get(META_SIGNATURE_HEADER), this.appSecret(channel));
  }

  async parseWebhook(request: Request, channel: ChannelRef): Promise<InboundEvent[]> {
    const payload = asRecord(await request.clone().json().catch(() => null));
    if (payload.object !== "whatsapp_business_account") return [];
    const events: InboundEvent[] = [];
    for (const entry of (payload.entry as unknown[] | undefined) ?? []) {
      for (const change of (asRecord(entry).changes as unknown[] | undefined) ?? []) {
        const value = asRecord(asRecord(change).value);
        // o mesmo app serve vários números: ignora eventos de outro número (isolamento entre canais)
        const phoneNumberId = asString(asRecord(value.metadata).phone_number_id);
        if (channel.credentials.phoneNumberId && phoneNumberId !== channel.credentials.phoneNumberId) continue;

        const names = new Map<string, string>();
        for (const contact of (value.contacts as unknown[] | undefined) ?? []) {
          const c = asRecord(contact);
          const waId = asString(c.wa_id);
          const name = asString(asRecord(c.profile).name);
          if (waId && name) names.set(waId, name);
        }
        for (const raw of (value.messages as unknown[] | undefined) ?? []) {
          const parsed = parseMessage(asRecord(raw), names);
          if (parsed) events.push(parsed);
        }
        for (const raw of (value.statuses as unknown[] | undefined) ?? []) {
          const parsed = parseStatus(asRecord(raw));
          if (parsed) events.push(parsed);
        }
      }
    }
    return events;
  }
}

function parseMessage(message: Record<string, unknown>, names: Map<string, string>): InboundEvent | undefined {
  const id = asString(message.id);
  const waId = asString(message.from);
  const from = toE164(waId);
  if (!id || !waId || !from) return undefined;
  const at = isoFromSeconds(message.timestamp);
  const name = names.get(waId);
  const base = { type: "message" as const, externalId: id, from, ...(name ? { name } : {}), at, windowExpiresAt: windowExpiresAt(at).toISOString() };

  switch (asString(message.type)) {
    case "text":
      return { ...base, kind: "text", text: asString(asRecord(message.text).body) };
    case "image": {
      const media = asRecord(message.image);
      return { ...base, kind: "image", text: asString(media.caption), mediaRef: asString(media.id) };
    }
    case "audio":
      return { ...base, kind: "audio", mediaRef: asString(asRecord(message.audio).id) };
    case "document": {
      const media = asRecord(message.document);
      return { ...base, kind: "document", text: asString(media.caption), mediaRef: asString(media.id) };
    }
    case "button":
      return { ...base, kind: "text", text: asString(asRecord(message.button).text) };
    case "interactive": {
      const interactive = asRecord(message.interactive);
      const reply = asRecord(interactive.button_reply ?? interactive.list_reply);
      return { ...base, kind: "text", text: asString(reply.title) };
    }
    default:
      return { ...base, kind: "other" };
  }
}

function parseStatus(status: Record<string, unknown>): InboundEvent | undefined {
  const id = asString(status.id);
  const mapped = ((): "sent" | "delivered" | "read" | "failed" | undefined => {
    switch (asString(status.status)) {
      case "sent":
        return "sent";
      case "delivered":
        return "delivered";
      case "read":
        return "read";
      case "failed":
        return "failed";
      default:
        return undefined;
    }
  })();
  if (!id || !mapped) return undefined;
  return { type: "status", externalId: id, status: mapped, at: isoFromSeconds(status.timestamp) };
}
