import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());
const optionalText = z.preprocess(emptyToUndefined, z.string().optional());
/** "true"/"1"/"sim" e "false"/"0"/"nao" (qualquer caixa); vazio = padrão. */
const boolFlag = (fallback: boolean) =>
  z.preprocess((value) => {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const v = value.trim().toLowerCase();
    if (["true", "1", "yes", "sim", "on"].includes(v)) return true;
    if (["false", "0", "no", "nao", "não", "off"].includes(v)) return false;
    return value; // inválido: o z.boolean() abaixo recusa e derruba o boot com mensagem clara
  }, z.boolean().default(fallback));

const configSchema = z.object({
  /** Evolution API v2 (container local em http://localhost:8081). */
  EVOLUTION_URL: z.preprocess(emptyToUndefined, z.url().default("http://localhost:8081")),
  /** Chave global da Evolution (AUTHENTICATION_API_KEY). Sem ela, o provedor QR responde "não configurado". */
  EVOLUTION_API_KEY: optionalText,
  /** Base pública da API (a Meta chama daqui). Ex.: https://api.duckzap.app. Padrão: PUBLIC_API_URL. */
  PUBLIC_WEBHOOK_BASE_URL: optionalUrl,
  /** Base da API vista DE DENTRO do container da Evolution (dev: http://host.docker.internal:4000). Padrão: a pública. */
  EVOLUTION_WEBHOOK_BASE_URL: optionalUrl,
  PUBLIC_API_URL: optionalUrl,
  /** Segredo do app Meta da plataforma (valida X-Hub-Signature-256). Pode ser sobrescrito por canal. */
  META_APP_SECRET: optionalText,
  META_GRAPH_URL: z.preprocess(emptyToUndefined, z.url().default("https://graph.facebook.com/v21.0")),
  /** Validade do QR mostrado ao usuário. */
  CHANNELS_QR_TTL_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(10).max(120).default(30)),
  /** Rate limit de envio por canal (balde de fichas): capacidade e reposição por segundo. */
  CHANNELS_SEND_BURST_QR: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(100).default(5)),
  CHANNELS_SEND_PER_SECOND_QR: z.preprocess(emptyToUndefined, z.coerce.number().min(0.1).max(100).default(1)),
  CHANNELS_SEND_BURST_OFFICIAL: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(500).default(40)),
  CHANNELS_SEND_PER_SECOND_OFFICIAL: z.preprocess(emptyToUndefined, z.coerce.number().min(0.1).max(500).default(20)),
  /** Limite de pedidos por IP no webhook público. */
  CHANNELS_WEBHOOK_BURST: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(10_000).default(300)),
  CHANNELS_WEBHOOK_PER_SECOND: z.preprocess(emptyToUndefined, z.coerce.number().min(0.1).max(10_000).default(50)),
  /**
   * "Digitando…" no WhatsApp por QR (Evolution): enviar ao contato (`sendPresence`, `delay` no envio) e receber
   * `PRESENCE_UPDATE`. false desliga os dois lados (a capacidade `presence` some e o evento deixa de ser pedido).
   */
  PRESENCE_ENABLED: boolFlag(true),
  /** Ao subir, reaplica o webhook (com PRESENCE_UPDATE) nas instâncias QR já conectadas. Só tem efeito com PRESENCE_ENABLED. */
  PRESENCE_WEBHOOK_SYNC: boolFlag(true),
});

export type ChannelsConfig = {
  evolutionUrl: string;
  evolutionApiKey: string | undefined;
  /** Base usada nas URLs mostradas ao usuário (Meta). */
  publicWebhookBaseUrl: string;
  /** Base usada ao registrar o webhook na Evolution. */
  evolutionWebhookBaseUrl: string;
  metaAppSecret: string | undefined;
  metaGraphUrl: string;
  qrTtlSeconds: number;
  sendLimits: { qr: { burst: number; perSecond: number }; official: { burst: number; perSecond: number } };
  webhookLimit: { burst: number; perSecond: number };
  /** `PRESENCE_ENABLED`: liga/desliga o "digitando…" (envio e recebimento). */
  presenceEnabled: boolean;
  /** `PRESENCE_WEBHOOK_SYNC` (já combinado com `presenceEnabled`). */
  presenceWebhookSync: boolean;
};

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/** Lê e valida as variáveis do módulo (chamado no boot de `channelsRoutes`: configuração inválida derruba o app). */
export function loadChannelsConfig(env: Record<string, string | undefined> = process.env): ChannelsConfig {
  const raw = configSchema.parse(env);
  const publicBase = trimSlash(raw.PUBLIC_WEBHOOK_BASE_URL ?? raw.PUBLIC_API_URL ?? "http://localhost:4000");
  return {
    evolutionUrl: trimSlash(raw.EVOLUTION_URL),
    evolutionApiKey: raw.EVOLUTION_API_KEY,
    publicWebhookBaseUrl: publicBase,
    evolutionWebhookBaseUrl: trimSlash(raw.EVOLUTION_WEBHOOK_BASE_URL ?? publicBase),
    metaAppSecret: raw.META_APP_SECRET,
    metaGraphUrl: trimSlash(raw.META_GRAPH_URL),
    qrTtlSeconds: raw.CHANNELS_QR_TTL_SECONDS,
    sendLimits: {
      qr: { burst: raw.CHANNELS_SEND_BURST_QR, perSecond: raw.CHANNELS_SEND_PER_SECOND_QR },
      official: { burst: raw.CHANNELS_SEND_BURST_OFFICIAL, perSecond: raw.CHANNELS_SEND_PER_SECOND_OFFICIAL },
    },
    webhookLimit: { burst: raw.CHANNELS_WEBHOOK_BURST, perSecond: raw.CHANNELS_WEBHOOK_PER_SECOND },
    presenceEnabled: raw.PRESENCE_ENABLED,
    presenceWebhookSync: raw.PRESENCE_ENABLED && raw.PRESENCE_WEBHOOK_SYNC,
  };
}

export function webhookUrl(base: string, provider: "evolution" | "meta", token: string) {
  return `${base}/v1/webhooks/wa/${provider}/${token}`;
}
