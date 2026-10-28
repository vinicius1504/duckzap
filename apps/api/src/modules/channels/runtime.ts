import type { ProviderKind } from "../../lib/messaging";
import { dbLinks, type LinkLookup } from "./links";
import { loadChannelsConfig, type ChannelsConfig } from "./config";
import { createProviderRegistry, type ProviderRegistry } from "./providers/registry";
import { InMemoryTokenBucket, type RateLimiter } from "./rate-limit";
import { allowAll, type WebhookAllowlist } from "./security";

export type ChannelsRuntime = {
  config: ChannelsConfig;
  providers: ProviderRegistry;
  links: LinkLookup;
  /** Limite de envio por canal; a chave é o id do canal. */
  sendLimiterFor(provider: ProviderKind): RateLimiter;
  /** Limite de pedidos por IP no webhook público. */
  webhookLimiter: RateLimiter;
  /** Presença recebida ("digitando…"): limite por canal (chave = id do canal) e por contato (canal + telefone). Excesso é descartado. */
  presenceChannelLimiter: RateLimiter;
  presenceContactLimiter: RateLimiter;
  allowlist: WebhookAllowlist;
  now(): Date;
  /** Agenda trabalho em segundo plano (padrão: promessa solta com log de erro; BullMQ no futuro). */
  background(task: () => Promise<void>): void;
  log: { warn(message: string, meta?: Record<string, unknown>): void; error(message: string, meta?: Record<string, unknown>): void };
};

const consoleLog = {
  warn: (message: string, meta?: Record<string, unknown>) => console.warn(message, meta ?? ""),
  error: (message: string, meta?: Record<string, unknown>) => console.error(message, meta ?? ""),
};

/** Presença é só enfeite: balde pequeno por canal e menor ainda por contato (uma conversa não monopoliza o canal). */
export const PRESENCE_LIMITS = { channel: { burst: 20, perSecond: 5 }, contact: { burst: 4, perSecond: 0.5 } } as const;

export function createChannelsRuntime(overrides: Partial<ChannelsRuntime> & { config?: ChannelsConfig } = {}): ChannelsRuntime {
  const config = overrides.config ?? loadChannelsConfig();
  const qr = new InMemoryTokenBucket({ capacity: config.sendLimits.qr.burst, refillPerSecond: config.sendLimits.qr.perSecond });
  const official = new InMemoryTokenBucket({ capacity: config.sendLimits.official.burst, refillPerSecond: config.sendLimits.official.perSecond });
  const log = overrides.log ?? consoleLog;
  return {
    config,
    providers: createProviderRegistry(config),
    links: dbLinks,
    sendLimiterFor: (provider) => (provider === "meta_cloud" ? official : qr),
    webhookLimiter: new InMemoryTokenBucket({ capacity: config.webhookLimit.burst, refillPerSecond: config.webhookLimit.perSecond }),
    presenceChannelLimiter: new InMemoryTokenBucket({ capacity: PRESENCE_LIMITS.channel.burst, refillPerSecond: PRESENCE_LIMITS.channel.perSecond }),
    presenceContactLimiter: new InMemoryTokenBucket({ capacity: PRESENCE_LIMITS.contact.burst, refillPerSecond: PRESENCE_LIMITS.contact.perSecond }),
    allowlist: allowAll,
    now: () => new Date(),
    background: (task) => {
      void task().catch((error: unknown) => log.error("channels.background_failed", { error: error instanceof Error ? error.name : "unknown" }));
    },
    log,
    ...overrides,
  };
}

let shared: ChannelsRuntime | undefined;
/** Instância compartilhada do processo (usada por `sendViaChannel` quando o chamador não passa a sua). */
export function getChannelsRuntime() {
  shared ??= createChannelsRuntime();
  return shared;
}
export function setChannelsRuntime(runtime: ChannelsRuntime) {
  shared = runtime;
}
