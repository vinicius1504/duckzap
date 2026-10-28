import { withOrg, type Database } from "@duckzap/db";
import { sql } from "drizzle-orm";
import type { ChannelRef, InboundEvent } from "../../lib/messaging";
import { dispatchPresence, type PresenceContext } from "../../lib/presence";
import { processInbound, recordInbound, type RecordInput } from "./inbound-store";
import { providerKindForWebhookSegment } from "./providers/registry";
import { buildRef, findChannel } from "./repo";
import type { ChannelsRuntime } from "./runtime";
import { clientIp, hashWebhookToken, MAX_WEBHOOK_BODY_BYTES, WEBHOOK_TOKEN_PATTERN } from "./security";

/** Lê o corpo como texto parando assim que passar de `maxBytes` (devolve null). */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type WebhookOutcome =
  | { status: 200; body: { ok: true; received: number; duplicates: number } }
  | { status: 200; text: string }
  | { status: 401 | 403 | 404 | 413 | 429; body: { error: { code: string; message: string } } };

const err = (status: 401 | 403 | 404 | 413 | 429, code: string, message: string): WebhookOutcome => ({ status, body: { error: { code, message } } });
/** Mesma resposta para token inexistente, formato inválido e provedor trocado: nada de oráculo de existência. */
const NOT_FOUND = err(404, "not_found", "Não encontrado.");

type Resolved = { organization_id: string; channel_id: string; provider: string };

/**
 * Busca estreita SEM tenant, pelo hash do token (função SECURITY DEFINER `dz_resolve_channel_by_token`, ver channels.sql.md).
 * Devolve só ids; tudo o que vem depois roda em `withOrg` sob RLS normal.
 */
export async function resolveChannelByToken(db: Database, token: string): Promise<Resolved | undefined> {
  const rows = await db.execute<Resolved>(sql`select organization_id, channel_id, provider from dz_resolve_channel_by_token(${hashWebhookToken(token)})`);
  return rows[0];
}

/** Acesso a dados do webhook como porta: o código de segurança roda igual em teste (sem banco) e em produção. */
export type WebhookPorts = {
  resolve(token: string): Promise<Resolved | undefined>;
  loadRef(organizationId: string, channelId: string): Promise<ChannelRef | undefined>;
  record(input: RecordInput): Promise<{ ids: string[]; duplicates: number }>;
  process(organizationId: string, ids: string[]): Promise<void>;
  /** Presença ("digitando…"): efêmera, sem gravar. Nunca lança. */
  presence(context: PresenceContext): Promise<void>;
};

export function databasePorts(db: Database, rt: ChannelsRuntime): WebhookPorts {
  return {
    resolve: (token) => resolveChannelByToken(db, token),
    loadRef: (organizationId, channelId) =>
      withOrg(db, organizationId, async (tx) => {
        const row = await findChannel(tx, organizationId, channelId);
        return row ? buildRef(row, rt) : undefined;
      }),
    record: (input) => recordInbound(db, input),
    process: async (organizationId, ids) => {
      await processInbound(db, organizationId, rt, { ids });
    },
    presence: (context) => dispatchPresence(context),
  };
}

/**
 * Webhook público de entrada (§3.3, §3.6, §5.3). Ordem: limite por IP → token → provedor confere → allowlist →
 * verificação do provedor (HMAC / segredo) → grava o evento bruto (idempotente) → responde 200 → processa em segundo plano.
 * O corpo é lido uma vez como texto (a HMAC é sobre os bytes exatos).
 */
export async function handleWebhook(
  deps: { ports: WebhookPorts; rt: ChannelsRuntime },
  request: Request,
  params: { provider: string; token: string },
): Promise<WebhookOutcome> {
  const { ports, rt } = deps;
  const ip = clientIp(request.headers);

  const limit = await rt.webhookLimiter.take(ip ?? "unknown");
  if (!limit.allowed) return err(429, "rate_limited", "Muitos pedidos.");

  const expectedKind = providerKindForWebhookSegment[params.provider];
  if (!expectedKind || !WEBHOOK_TOKEN_PATTERN.test(params.token)) return NOT_FOUND;
  const resolved = await ports.resolve(params.token);
  if (!resolved || resolved.provider !== expectedKind) return NOT_FOUND;
  const provider = rt.providers.get(resolved.provider);
  if (!provider) return NOT_FOUND;

  if (!rt.allowlist({ provider: resolved.provider, ip })) return err(403, "forbidden", "Origem não permitida.");

  const organizationId = resolved.organization_id;
  const ref = await ports.loadRef(organizationId, resolved.channel_id);
  if (!ref) return NOT_FOUND;

  // --- GET: handshake da Meta (hub.challenge) ---
  if (request.method === "GET") {
    if (resolved.provider !== "meta_cloud") return NOT_FOUND;
    if (!(await provider.verifyWebhook(request, ref))) return err(403, "forbidden", "Token de verificação inválido.");
    const challenge = new URL(request.url).searchParams.get("hub.challenge") ?? "";
    return { status: 200, text: challenge };
  }

  // --- POST ---
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_WEBHOOK_BODY_BYTES) return err(413, "too_large", "Corpo grande demais.");
  // limite real no stream: content-length ausente (chunked) ou mentiroso não deixa o corpo inteiro entrar na memória
  const rawBody = await readBodyLimited(request, MAX_WEBHOOK_BODY_BYTES);
  if (rawBody === null) return err(413, "too_large", "Corpo grande demais.");

  const verifiable = new Request(request.url, { method: "POST", headers: request.headers, body: rawBody });
  let verified = false;
  try {
    verified = await provider.verifyWebhook(verifiable, ref);
  } catch {
    verified = false;
  }
  if (!verified) return err(401, "unauthorized", "Assinatura inválida.");

  let events: InboundEvent[] = [];
  let parseFailed = false;
  try {
    JSON.parse(rawBody);
    events = await provider.parseWebhook(new Request(request.url, { method: "POST", headers: request.headers, body: rawBody }), ref);
  } catch {
    parseFailed = true;
  }

  // presença ("digitando…") é efêmera: não é gravada, não tem id externo e não passa pela idempotência
  const presenceEvents = events.filter((event): event is Extract<InboundEvent, { type: "presence" }> => event.type === "presence");
  const storable = events.filter((event) => event.type !== "presence");
  if (presenceEvents.length > 0) await acceptPresence(deps, resolved.channel_id, organizationId, presenceEvents);
  if (!parseFailed && storable.length === 0 && presenceEvents.length > 0) return { status: 200, body: { ok: true, received: 0, duplicates: 0 } };

  const { ids, duplicates } = await ports.record({ organizationId, channelId: resolved.channel_id, rawBody, events: storable, parseFailed });
  // responde já; o despacho não pode atrasar nem derrubar o 200 (o evento está guardado e é reprocessável)
  if (ids.length > 0) rt.background(() => ports.process(organizationId, ids));
  return { status: 200, body: { ok: true, received: ids.length, duplicates } };
}

/** Só estes valores importam para a tela; `available`/`unavailable` (entrou/saiu do app) são descartados aqui. */
const RELEVANT_PRESENCES = new Set(["composing", "recording", "paused"]);
const MAX_PRESENCE_PER_REQUEST = 5;

/**
 * Aplica o limite (por canal e por contato) e entrega o que passou em segundo plano. Nunca lança nem atrasa o 200:
 * rajada além do limite é simplesmente descartada. A empresa vem do token do canal (nunca do corpo).
 */
async function acceptPresence(
  deps: { ports: WebhookPorts; rt: ChannelsRuntime },
  channelId: string,
  organizationId: string,
  events: Extract<InboundEvent, { type: "presence" }>[],
) {
  const { ports, rt } = deps;
  if (!rt.config.presenceEnabled) return;
  try {
    for (const event of events.slice(0, MAX_PRESENCE_PER_REQUEST)) {
      if (!RELEVANT_PRESENCES.has(event.presence)) continue;
      // primeiro o contato: quem inunda gasta só a própria cota e não esvazia a do canal
      if (!(await rt.presenceContactLimiter.take(`${channelId}:${event.from}`)).allowed) continue;
      if (!(await rt.presenceChannelLimiter.take(channelId)).allowed) return;
      rt.background(() => ports.presence({ organizationId, channelId, from: event.from, presence: event.presence }));
    }
  } catch {
    // presença nunca derruba o webhook
  }
}
