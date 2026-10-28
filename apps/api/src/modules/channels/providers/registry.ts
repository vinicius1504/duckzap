import type { ChannelType } from "@duckzap/contracts/channels";
import type { MessagingProvider, ProviderKind } from "../../../lib/messaging";
import type { ChannelsConfig } from "../config";
import { EvolutionProvider } from "./evolution";
import { InstagramProvider } from "./instagram";
import { MetaCloudProvider } from "./meta-cloud";
import type { FetchLike } from "./shared";

export type ProviderRegistry = {
  get(kind: ProviderKind): MessagingProvider | undefined;
  kinds(): ProviderKind[];
};

export function createProviderRegistry(config: ChannelsConfig, options: { fetch?: FetchLike } = {}): ProviderRegistry {
  const providers: MessagingProvider[] = [
    new EvolutionProvider({ baseUrl: config.evolutionUrl, apiKey: config.evolutionApiKey, presenceEnabled: config.presenceEnabled, ...(options.fetch ? { fetch: options.fetch } : {}) }),
    new MetaCloudProvider({ graphUrl: config.metaGraphUrl, appSecret: config.metaAppSecret, ...(options.fetch ? { fetch: options.fetch } : {}) }),
    new InstagramProvider(),
  ];
  const byKind = new Map(providers.map((p) => [p.kind as ProviderKind, p]));
  return { get: (kind) => byKind.get(kind), kinds: () => [...byKind.keys()] };
}

/** Tipo de canal do produto → provedor que o atende. */
export const providerKindForType: Record<ChannelType, ProviderKind> = {
  whatsapp_qr: "evolution",
  whatsapp_official: "meta_cloud",
  instagram: "instagram",
};

/** Segmento `{provider}` da URL pública do webhook → provedor. */
export const providerKindForWebhookSegment: Record<string, ProviderKind> = {
  evolution: "evolution",
  meta: "meta_cloud",
};

export const webhookSegmentForKind = (kind: ProviderKind): "evolution" | "meta" | undefined =>
  kind === "evolution" ? "evolution" : kind === "meta_cloud" ? "meta" : undefined;
