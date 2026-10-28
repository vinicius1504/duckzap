import { z } from "zod";

/**
 * Interface única de provedores de mensagem (INSTRUCTIONS §3.6). O domínio (conversas, agentes,
 * campanhas) só conhece estes tipos canônicos, nunca o formato de um provedor.
 * Dono: módulo Canais (adaptadores em modules/channels/providers/*). Mude só com aviso.
 */
export type ProviderKind = "meta_cloud" | "evolution" | "instagram" | (string & {});

export type ConnectionStatus = "connected" | "qr_pending" | "awaiting_authorization" | "disconnected" | "banned";

export type ProviderCapabilities = {
  buttons: boolean;
  lists: boolean;
  templates: boolean;
  media: boolean;
  reactions: boolean;
  /** Janela de 24 h da API oficial: fora dela só template aprovado. */
  window24h: boolean;
  /** Presença "digitando…": `sendPresence`, `OutboundMessage.typingMs` e eventos `presence` de entrada. */
  presence: boolean;
};

/** Teto (ms) de "digitando…" antes de entregar uma mensagem; vale para o schema, os adaptadores e os chamadores. */
export const MAX_TYPING_MS = 8_000;
/** Teto (ms) de uma presença avulsa (`sendPresence`): o atendente digitando renova a cada poucos segundos. */
export const MAX_PRESENCE_MS = 15_000;

/** Presenças que podemos ENVIAR (a Evolution também tem `available`/`unavailable`, que o produto não usa). */
export type OutboundPresence = "composing" | "recording" | "paused";
export type InboundPresence = OutboundPresence | "available" | "unavailable";

export const outboundMessageSchema = z.object({
  /** Idempotência: o mesmo id nunca envia duas vezes. */
  externalId: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(["text", "image", "audio", "document", "template"]),
  text: z.string().max(4096).optional(),
  mediaUrl: z.url().optional(),
  /** Legenda/nome do arquivo (mídia). */
  filename: z.string().max(255).optional(),
  /** Só `kind: "template"` (API oficial: único formato permitido fora da janela de 24 h). */
  template: z
    .object({
      name: z.string().min(1).max(512),
      language: z.string().min(2).max(10),
      /** Valores das variáveis {{1}}, {{2}}… do corpo, na ordem. */
      bodyParams: z.array(z.string().max(1024)).max(20).optional(),
    })
    .optional(),
  /**
   * Opcional: mostrar "digitando…" ao contato por este tempo ANTES de entregar a mensagem (Evolution: campo nativo `delay`).
   * Provedores sem a capacidade `presence` ignoram. Quem monta a mensagem NUNCA espera por conta própria.
   */
  typingMs: z.number().int().min(0).max(MAX_TYPING_MS).optional(),
});
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; code: "rate_limited" | "disconnected" | "rejected" | "plan_paused" | "unknown"; message: string };

export type InboundEvent =
  | {
      type: "message";
      externalId: string;
      from: string;
      name?: string;
      kind: "text" | "image" | "audio" | "document" | "other";
      text?: string;
      mediaUrl?: string;
      /** Referência para baixar a mídia no provedor (Meta: media id; Evolution: id da mensagem). */
      mediaRef?: string;
      at: string;
      /** API oficial: até quando vale a janela de 24 h para resposta em texto livre. */
      windowExpiresAt?: string;
    }
  | { type: "status"; externalId: string; status: "sent" | "delivered" | "read" | "failed"; at: string }
  | {
      type: "connection";
      status: ConnectionStatus;
      at: string;
      /** Evolution `qrcode.updated`: novo QR (status `qr_pending`). */
      qrCode?: string;
      pairingCode?: string;
    }
  /** Efêmero: o contato está digitando/gravando/parou. NUNCA é gravado nem passa pela idempotência (sem id externo). */
  | { type: "presence"; from: string; presence: InboundPresence; at: string };

export const inboundEventSchema: z.ZodType<InboundEvent> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    externalId: z.string().min(1),
    from: z.string().min(1),
    name: z.string().optional(),
    kind: z.enum(["text", "image", "audio", "document", "other"]),
    text: z.string().optional(),
    mediaUrl: z.string().optional(),
    mediaRef: z.string().optional(),
    at: z.iso.datetime(),
    windowExpiresAt: z.iso.datetime().optional(),
  }),
  z.object({
    type: z.literal("status"),
    externalId: z.string().min(1),
    status: z.enum(["sent", "delivered", "read", "failed"]),
    at: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("connection"),
    status: z.enum(["connected", "qr_pending", "awaiting_authorization", "disconnected", "banned"]),
    at: z.iso.datetime(),
    qrCode: z.string().optional(),
    pairingCode: z.string().optional(),
  }),
  z.object({
    type: z.literal("presence"),
    from: z.string().min(1),
    presence: z.enum(["composing", "recording", "paused", "available", "unavailable"]),
    at: z.iso.datetime(),
  }),
]);

/** Erro de um adaptador (credencial recusada, provedor fora do ar…). Nunca leva segredo na mensagem. */
export class ProviderError extends Error {
  constructor(
    readonly code: "invalid_credentials" | "unavailable" | "not_configured" | "not_implemented" | "rejected",
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Credenciais do canal já decifradas (a cifra vive no módulo Canais). */
export type ChannelCredentials = Record<string, string>;
export type ChannelRef = {
  id: string;
  organizationId: string;
  credentials: ChannelCredentials;
  address?: string;
  /** URL pública (com o token do canal) para onde o provedor deve enviar eventos. */
  webhookUrl?: string;
};

export type ConnectResult = {
  status: ConnectionStatus;
  qrCode?: string;
  pairingCode?: string;
  /** Número/@ descoberto ao conectar. */
  address?: string;
  /** Credenciais novas/atualizadas a persistir (cifradas pelo módulo Canais). */
  credentials?: ChannelCredentials;
};

/**
 * Contato que o WhatsApp conectado conhece (agenda do aparelho). `person` tem número; `hidden` é ID oculto (`@lid`, sem
 * número); `group` e `other` (transmissão, status, canal) não são pessoas. `name` é o nome útil ou null (vazio ou só número).
 */
export type ProviderContact = {
  jid: string;
  kind: "person" | "group" | "hidden" | "other";
  /** Só dígitos (8–15), sem "+"; só para `person`. */
  phoneDigits: string | null;
  name: string | null;
};

export interface MessagingProvider {
  readonly kind: ProviderKind;
  capabilities(): ProviderCapabilities;
  connect(channel: ChannelRef): Promise<ConnectResult>;
  disconnect(channel: ChannelRef): Promise<void>;
  status(channel: ChannelRef): Promise<ConnectionStatus>;
  send(channel: ChannelRef, message: OutboundMessage): Promise<SendResult>;
  verifyWebhook(request: Request, channel: ChannelRef): Promise<boolean>;
  parseWebhook(request: Request, channel: ChannelRef): Promise<InboundEvent[]>;
  /** Opcional: status + endereço (número) numa consulta só. */
  inspect?(channel: ChannelRef): Promise<{ status: ConnectionStatus; address?: string }>;
  /** Opcional: reaponta o webhook do provedor para `channel.webhookUrl` (rotação do token). */
  updateWebhook?(channel: ChannelRef): Promise<void>;
  /**
   * Opcional: confere o webhook registrado no provedor e só o reaplica se faltar evento/URL (idempotente, sem escrita
   * quando já está certo). Serve para instâncias criadas antes de um evento novo (ex.: presença) existir.
   */
  syncWebhook?(channel: ChannelRef): Promise<"updated" | "unchanged">;
  /**
   * Opcional (capacidade `presence`): mostra "digitando…"/"gravando…" ao contato por `durationMs` e volta a "parou".
   * Falha de rede/recusa lança `ProviderError`; o chamador trata presença como melhor esforço.
   */
  sendPresence?(channel: ChannelRef, input: { to: string; presence: OutboundPresence; durationMs: number }): Promise<void>;
  /**
   * Opcional: contatos que o WhatsApp conectado conhece (importação para Clientes). Chamada pesada (milhares de itens).
   * Falha de rede/recusa lança `ProviderError`; nomes e números são dado pessoal e nunca vão para log.
   */
  listContacts?(channel: ChannelRef): Promise<ProviderContact[]>;
}
