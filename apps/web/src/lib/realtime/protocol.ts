import { realtimeCloseCodes, serverMessageSchema, type ServerMessage } from "@duckzap/contracts/realtime";

/**
 * Peças puras do tempo real (sem React, sem navegador): parse, dedupe, política de fechamento,
 * backoff e resolução da URL. Tudo testável em Node.
 */

/** Mensagens maiores que isso não são do nosso servidor (eventos são só ids): descarta. */
const MAX_MESSAGE_CHARS = 16_384;

/** Texto JSON do servidor → mensagem validada pelo contrato; qualquer coisa inválida vira `null` (ignorada). */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_MESSAGE_CHARS) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = serverMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Guarda os últimos `size` ids vistos. `seen(id)` devolve `true` se já tinha (repetido) e registra se não. */
export function createDedupe(size = 200): { seen(id: string): boolean; clear(): void } {
  const ids = new Set<string>();
  return {
    seen(id) {
      if (ids.has(id)) return true;
      ids.add(id);
      if (ids.size > size) {
        // Set mantém a ordem de inserção: o primeiro é o mais antigo
        const oldest = ids.values().next();
        if (!oldest.done) ids.delete(oldest.value);
      }
      return false;
    },
    clear: () => ids.clear(),
  };
}

export type CloseDecision =
  | { action: "retry" }
  | { action: "stop"; reason: "unauthorized" | "suspended" | "forbidden_origin" };

/** O que fazer quando o servidor fecha a conexão. Só estes três códigos encerram de vez; o resto reconecta. */
export function closePolicy(code: number): CloseDecision {
  switch (code) {
    case realtimeCloseCodes.unauthorized:
      return { action: "stop", reason: "unauthorized" };
    case realtimeCloseCodes.suspended:
      return { action: "stop", reason: "suspended" };
    case realtimeCloseCodes.forbiddenOrigin:
      return { action: "stop", reason: "forbidden_origin" };
    default:
      // inclui 4503 (servidor reiniciando) e 1006 (queda sem código)
      return { action: "retry" };
  }
}

export type BackoffOptions = { baseMs?: number; capMs?: number };

/**
 * Espera antes da tentativa `attempt` (0 = primeira nova tentativa): 1 s, 2 s, 4 s… até 30 s,
 * com jitter de 50% a 100% do valor para os clientes não reconectarem todos juntos.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random, { baseMs = 1000, capMs = 30_000 }: BackoffOptions = {}): number {
  const exponent = Number.isFinite(attempt) ? Math.min(Math.max(0, Math.floor(attempt)), 30) : 0;
  const ceiling = Math.min(capMs, baseMs * 2 ** exponent);
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(ceiling * (0.5 + 0.5 * r));
}

export type RealtimeUrlInput = {
  /** `process.env.NEXT_PUBLIC_REALTIME_URL` */
  envUrl?: string | undefined;
  isDev: boolean;
  /** `window.location` (só o que usamos) */
  location: { protocol: string; host: string; hostname: string };
};

/**
 * Endereço do WebSocket. Prioridade: variável de ambiente (ws/wss); em desenvolvimento, a porta 4001 do mesmo host;
 * em produção, `wss://<mesmo host>/ws` (o proxy reverso encaminha /ws para o serviço de tempo real).
 */
export function resolveRealtimeUrl({ envUrl, isDev, location }: RealtimeUrlInput): string | null {
  const configured = envUrl?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      return url.protocol === "ws:" || url.protocol === "wss:" ? url.toString() : null;
    } catch {
      return null;
    }
  }
  const secure = location.protocol === "https:";
  if (isDev) return `${secure ? "wss" : "ws"}://${location.hostname || "localhost"}:4001/ws`;
  return `${secure ? "wss" : "ws"}://${location.host}/ws`;
}
