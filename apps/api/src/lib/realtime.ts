import { realtimeChannel, realtimeEnvelopeSchema, type RealtimeEnvelope, type RealtimeEvent } from "@duckzap/contracts/realtime";
import { withOrg, type Database, type Transaction } from "@duckzap/db";
import { Redis } from "ioredis";
import { v7 } from "uuid";
import { loadRealtimeConfig } from "./realtime-config";

/**
 * Publicação de eventos em tempo real (contrato: packages/contracts/src/realtime.ts).
 *
 * Regras:
 *  - O evento é um AVISO só com ids. Nunca texto de mensagem, nome ou telefone: o envelope é validado com
 *    `realtimeEnvelopeSchema`, que descarta qualquer chave fora do contrato.
 *  - Melhor esforço: `publishRealtime` NUNCA lança e NUNCA espera o Redis. Se o Valkey cair, a tela só deixa de
 *    atualizar sozinha (ela ainda busca os dados pela API normal).
 *  - Quem muda dados usa `queueRealtime(tx, …)` dentro da transação e `withOrgRealtime` (ou `flushRealtime`) publica
 *    DEPOIS do commit; assim quem recebe o aviso nunca busca dado velho.
 */

export type RealtimePublisher = (envelope: RealtimeEnvelope) => void | Promise<void>;

const COMMAND_TIMEOUT_MS = 1_000;
/** Teto de publicações em andamento (inclui a fila offline do ioredis enquanto reconecta). Acima disso, descarta. */
const MAX_IN_FLIGHT = 200;
const LOG_EVERY_MS = 15_000;

const log = {
  warn: (message: string, meta?: Record<string, unknown>) => console.warn(message, meta ?? ""),
};

// ── envelope ────────────────────────────────────────────────────────────────

/** Monta e valida o envelope. Chaves fora do contrato são descartadas; evento inválido devolve null. */
export function buildEnvelope(organizationId: string, event: RealtimeEvent, now: Date = new Date()): RealtimeEnvelope | null {
  const parsed = realtimeEnvelopeSchema.safeParse({ v: 1, id: v7(), organizationId, at: now.toISOString(), event });
  return parsed.success ? parsed.data : null;
}

// ── cliente Redis/Valkey (um só, preguiçoso) ───────────────────────────────

let client: Redis | null = null;
let clientForUrl: string | null = null;
let warnedNoConfig = false;
let inFlight = 0;
let lastLogAt = 0;
let dropped = 0;

function logThrottled(message: string, meta?: Record<string, unknown>) {
  const now = Date.now();
  if (now - lastLogAt < LOG_EVERY_MS) return;
  lastLogAt = now;
  log.warn(message, { ...(meta ?? {}), ...(dropped ? { dropped } : {}) });
  dropped = 0;
}

function getClient(): Redis | null {
  const { redisUrl, warning } = loadRealtimeConfig();
  if (!redisUrl) {
    if (!warnedNoConfig && warning) {
      warnedNoConfig = true;
      log.warn(`realtime: ${warning}`);
    }
    return null;
  }
  if (client && clientForUrl === redisUrl) return client;
  if (client) void closeClient(client);
  const created = new Redis(redisUrl, {
    connectionName: "duckzap-api-realtime",
    // fila offline pequena e limitada (MAX_IN_FLIGHT): a primeira publicação espera a conexão subir em vez de se perder
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    commandTimeout: COMMAND_TIMEOUT_MS,
    connectTimeout: 2_000,
    // reconecta sempre, com espera crescente (200 ms … 5 s)
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  // sem listener, o ioredis imprimiria o erro inteiro; aqui só o nome/código, sem conteúdo
  created.on("error", (error: Error & { code?: string }) => logThrottled("realtime: erro na conexão com o Valkey", { error: error.code ?? error.name }));
  client = created;
  clientForUrl = redisUrl;
  return created;
}

async function closeClient(target: Redis) {
  try {
    await Promise.race([target.quit(), new Promise((resolve) => setTimeout(resolve, 500))]);
  } catch {
    // ignora: encerrando
  }
  target.disconnect();
}

const redisPublisher: RealtimePublisher = (envelope) => {
  const redis = getClient();
  if (!redis) return;
  if (inFlight >= MAX_IN_FLIGHT) {
    dropped++;
    logThrottled("realtime: fila cheia, evento descartado");
    return;
  }
  inFlight++;
  return redis
    .publish(realtimeChannel(envelope.organizationId), JSON.stringify(envelope))
    .then(
      () => undefined,
      (error: Error & { code?: string }) => {
        dropped++;
        logThrottled("realtime: falha ao publicar evento", { error: error.code ?? error.name });
      },
    )
    .finally(() => {
      inFlight--;
    });
};

// ── API pública ─────────────────────────────────────────────────────────────

let publisher: RealtimePublisher = redisPublisher;

/** Testes: troca o destino das publicações por um falso (`null` volta ao Valkey). */
export function setRealtimePublisher(fake: RealtimePublisher | null) {
  publisher = fake ?? redisPublisher;
}

/**
 * Publica um aviso para a empresa. Dispara e esquece: nunca lança, nunca bloqueia a requisição.
 * Quem escreve no banco deve preferir `queueRealtime` (publica só depois do commit).
 */
export function publishRealtime(organizationId: string, event: RealtimeEvent): void {
  try {
    const envelope = buildEnvelope(organizationId, event);
    if (!envelope) {
      logThrottled("realtime: evento fora do contrato descartado");
      return;
    }
    const result = publisher(envelope);
    if (result && typeof result.catch === "function") {
      result.catch((error: unknown) => logThrottled("realtime: falha ao publicar evento", { error: error instanceof Error ? error.name : "unknown" }));
    }
  } catch (error) {
    logThrottled("realtime: falha ao publicar evento", { error: error instanceof Error ? error.name : "unknown" });
  }
}

/** Boot: avisa UMA vez se o tempo real está desligado e já abre a conexão. */
export function initRealtime(): void {
  try {
    getClient();
  } catch {
    // nunca derruba o boot
  }
}

/** Encerramento do processo: fecha a conexão (espera no máximo ~0,5 s). */
export async function closeRealtime(): Promise<void> {
  const current = client;
  client = null;
  clientForUrl = null;
  warnedNoConfig = false;
  if (current) await closeClient(current);
}

// ── eventos ligados à transação ─────────────────────────────────────────────

type Pending = { organizationId: string; event: RealtimeEvent };
const pendingByTx = new WeakMap<object, Map<string, Pending>>();

/**
 * Guarda o evento até a transação confirmar. Repetições idênticas na mesma transação viram uma só (o front só precisa
 * saber que "algo mudou"). Se a transação falhar, nada é publicado.
 */
export function queueRealtime(tx: Transaction, organizationId: string, event: RealtimeEvent): void {
  let bucket = pendingByTx.get(tx);
  if (!bucket) {
    bucket = new Map();
    pendingByTx.set(tx, bucket);
  }
  bucket.set(`${organizationId}|${JSON.stringify(event)}`, { organizationId, event });
}

/** Publica (e esquece) o que a transação guardou. Chame SÓ depois do commit. */
export function flushRealtime(tx: Transaction): void {
  const bucket = pendingByTx.get(tx);
  if (!bucket) return;
  pendingByTx.delete(tx);
  for (const { organizationId, event } of bucket.values()) publishRealtime(organizationId, event);
}

/** `withOrg` que publica os avisos guardados com `queueRealtime` depois do commit (nunca se a transação falhar). */
export async function withOrgRealtime<T>(db: Database, organizationId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const holder: { tx: Transaction | null } = { tx: null };
  const result = await withOrg(db, organizationId, (tx) => {
    holder.tx = tx;
    return fn(tx);
  });
  if (holder.tx) flushRealtime(holder.tx);
  return result;
}

/** Máximo de `conversation.updated` por ação em lote; acima disso, um único `home.invalidate` (e o front refaz a lista). */
export const MAX_BULK_CONVERSATION_EVENTS = 50;

/** Ação que mexe em várias conversas: um aviso por conversa até o teto; passou dele, um `home.invalidate` só. */
export function queueConversationUpdates(
  tx: Transaction,
  organizationId: string,
  conversationIds: readonly string[],
  reason: Extract<RealtimeEvent, { type: "conversation.updated" }>["reason"],
): void {
  const unique = [...new Set(conversationIds)];
  if (unique.length === 0) return;
  if (unique.length > MAX_BULK_CONVERSATION_EVENTS) {
    queueRealtime(tx, organizationId, { type: "home.invalidate" });
    return;
  }
  for (const conversationId of unique) queueRealtime(tx, organizationId, { type: "conversation.updated", conversationId, reason });
}
