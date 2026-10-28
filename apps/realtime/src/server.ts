import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  clientMessageSchema,
  realtimeChannel,
  realtimeCloseCodes,
  realtimeEnvelopeSchema,
  serverMessageSchema,
  type ServerMessage,
} from "@duckzap/contracts/realtime";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { RealtimeConfig } from "./config";
import type { SessionCheck, ValidateSession } from "./session";

/** O mínimo que o servidor usa do ioredis (e o que os testes simulam). */
export interface Subscriber {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

export type LogLevel = "info" | "warn" | "error";
/** Logs só com contagens e códigos. Nunca cookie, token, nome, e-mail, telefone ou conteúdo de evento. */
export type Logger = (level: LogLevel, msg: string, fields?: Record<string, number | string | boolean>) => void;

export interface RealtimeDeps {
  config: RealtimeConfig;
  subscriber: Subscriber;
  validateSession: ValidateSession;
  /** Relógio injetável (ms). Padrão: `Date.now`. */
  now?: () => number;
  log?: Logger;
  /** Para o /health dizer se a conexão com o Valkey está de pé. */
  subscriberHealthy?: () => boolean;
}

export interface RealtimeServer {
  /** Sobe o HTTP+WebSocket. Sem argumento usa `config.port`; `0` escolhe uma porta livre. Devolve a porta. */
  listen(port?: number): Promise<number>;
  /** Desligamento limpo: fecha sockets com 4503, para os timers, encerra o subscriber. */
  close(): Promise<void>;
  /** Um ciclo do heartbeat (ping + derruba quem não respondeu). Os timers chamam isto; testes também. */
  runHeartbeat(): void;
  /** Um ciclo de revalidação das sessões (fecha com 4401/4402). Os timers chamam isto; testes também. */
  runRevalidation(): Promise<void>;
  stats(): RealtimeStats;
  readonly httpServer: Server;
}

export interface RealtimeStats {
  connections: number;
  organizations: number;
  subscribedChannels: number;
  totalConnected: number;
  totalDisconnected: number;
  droppedInvalid: number;
  droppedForged: number;
}

const CHANNEL_PREFIX = realtimeChannel("");
const WS_PATH = "/ws";
const RATE_WINDOW_MS = 10_000;
const MAX_ENVELOPE_BYTES = 16 * 1024;
/** Cliente lento: se acumular mais que isto sem ler, derruba (evita memória crescer sem fim). */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const SUBSCRIBE_TIMEOUT_MS = 5000;
const REVALIDATE_CONCURRENCY = 10;
const SHUTDOWN_GRACE_MS = 2000;
const WARN_THROTTLE_MS = 10_000;

const consoleLogger: Logger = (level, msg, fields) => {
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: "realtime", msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
};

interface Connection {
  ws: WebSocket;
  organizationId: string;
  userId: string;
  /** Cookie guardado só em memória para revalidar a sessão; nunca vai para log. */
  cookie: string;
  ready: boolean;
  lastPongAt: number;
  windowStartedAt: number;
  windowCount: number;
}

function rawToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("failed"));
      },
    );
  });
}

function rejectHttp(socket: Duplex, status: number, text: string) {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

export function createRealtimeServer(deps: RealtimeDeps): RealtimeServer {
  const { config, subscriber, validateSession } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? consoleLogger;
  const allowedOrigins = new Set(config.webOrigins);

  const connections = new Set<Connection>();
  /** empresa → conexões dela. A ÚNICA tabela usada para decidir quem recebe um evento. */
  const orgs = new Map<string, Set<Connection>>();
  const userCounts = new Map<string, number>();
  const ipCounts = new Map<string, number>();
  const subscribed = new Set<string>();
  const subscribeChains = new Map<string, Promise<void>>();

  let shuttingDown = false;
  let revalidating = false;
  let totalConnected = 0;
  let totalDisconnected = 0;
  let droppedInvalid = 0;
  let droppedForged = 0;
  let lastWarnAt = Number.NEGATIVE_INFINITY;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let revalidateTimer: NodeJS.Timeout | undefined;

  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes, perMessageDeflate: false, clientTracking: false });

  const httpServer = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      const redis = deps.subscriberHealthy ? deps.subscriberHealthy() : true;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ status: "ok", redis: redis ? "up" : "down", connections: connections.size }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  function warnThrottled(msg: string) {
    const t = now();
    if (t - lastWarnAt < WARN_THROTTLE_MS) return;
    lastWarnAt = t;
    log("warn", msg, { droppedInvalid, droppedForged });
  }

  // ───────────────────────── assinatura preguiçosa no Valkey ─────────────────────────

  /**
   * Faz o Valkey refletir `orgs`: assina o canal da empresa se há conexões, cancela se não há.
   * Encadeado por canal para que subscribe/unsubscribe nunca se atropelem.
   */
  function reconcile(organizationId: string): Promise<void> {
    const channel = realtimeChannel(organizationId);
    const previous = subscribeChains.get(channel) ?? Promise.resolve();
    const next = previous.then(async () => {
      const wanted = (orgs.get(organizationId)?.size ?? 0) > 0;
      const have = subscribed.has(channel);
      if (wanted && !have) {
        await subscriber.subscribe(channel);
        subscribed.add(channel);
      } else if (!wanted && have) {
        await subscriber.unsubscribe(channel);
        subscribed.delete(channel);
      }
    });
    const settled = next.catch(() => undefined);
    subscribeChains.set(channel, settled);
    void settled.then(() => {
      if (subscribeChains.get(channel) === settled) subscribeChains.delete(channel);
    });
    return next;
  }

  // ───────────────────────── fan-out ─────────────────────────

  subscriber.on("message", (channel, message) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    const organizationId = channel.slice(CHANNEL_PREFIX.length);
    const group = orgs.get(organizationId);
    if (!group || group.size === 0) return;
    if (message.length > MAX_ENVELOPE_BYTES) {
      droppedInvalid += 1;
      warnThrottled("realtime_event_dropped");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(message);
    } catch {
      droppedInvalid += 1;
      warnThrottled("realtime_event_dropped");
      return;
    }
    const envelope = realtimeEnvelopeSchema.safeParse(json);
    if (!envelope.success) {
      droppedInvalid += 1;
      warnThrottled("realtime_event_dropped");
      return;
    }
    // ISOLAMENTO: o envelope tem de pertencer à empresa do canal em que chegou. Qualquer divergência é descartada.
    if (envelope.data.organizationId !== organizationId) {
      droppedForged += 1;
      warnThrottled("realtime_event_dropped");
      return;
    }
    const { id, at, event } = envelope.data;
    const frame = JSON.stringify(serverMessageSchema.parse({ type: "event", id, at, event }));
    for (const conn of group) {
      if (!conn.ready || conn.ws.readyState !== WebSocket.OPEN) continue;
      if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        conn.ws.terminate();
        continue;
      }
      conn.ws.send(frame, (error) => {
        if (error) conn.ws.terminate();
      });
    }
  });

  // ───────────────────────── conexões ─────────────────────────

  function send(conn: Connection, message: ServerMessage) {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    conn.ws.send(JSON.stringify(message), (error) => {
      if (error) conn.ws.terminate();
    });
  }

  function closeConnection(conn: Connection, code: number, reason: string) {
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) conn.ws.close(code, reason);
  }

  function onClientMessage(conn: Connection, data: RawData, isBinary: boolean) {
    const t = now();
    if (t - conn.windowStartedAt >= RATE_WINDOW_MS) {
      conn.windowStartedAt = t;
      conn.windowCount = 0;
    }
    conn.windowCount += 1;
    if (conn.windowCount > config.clientMessagesPer10s) return closeConnection(conn, 1008, "rate_limited");
    if (isBinary) return closeConnection(conn, 1003, "unsupported_data");
    let json: unknown;
    try {
      json = JSON.parse(rawToText(data));
    } catch {
      return closeConnection(conn, 1008, "invalid_message");
    }
    const message = clientMessageSchema.safeParse(json);
    if (!message.success) return closeConnection(conn, 1008, "invalid_message");
    if (message.data.type === "pong") conn.lastPongAt = t;
  }

  function onConnectionClosed(conn: Connection) {
    if (!connections.delete(conn)) return;
    totalDisconnected += 1;
    const group = orgs.get(conn.organizationId);
    if (group) {
      group.delete(conn);
      if (group.size === 0) orgs.delete(conn.organizationId);
    }
    reconcile(conn.organizationId).catch(() => log("error", "realtime_unsubscribe_failed"));
    log("info", "ws_disconnected", { active: connections.size });
  }

  async function activate(conn: Connection) {
    try {
      await withTimeout(reconcile(conn.organizationId), SUBSCRIBE_TIMEOUT_MS);
    } catch {
      log("error", "realtime_subscribe_failed");
      closeConnection(conn, 1013, "try_again_later");
      return;
    }
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    conn.ready = true;
    send(conn, { type: "ready" });
  }

  function register(ws: WebSocket, session: Extract<SessionCheck, { kind: "ok" }>, cookie: string) {
    const t = now();
    const conn: Connection = {
      ws,
      organizationId: session.organizationId,
      userId: session.userId,
      cookie,
      ready: false,
      lastPongAt: t,
      windowStartedAt: t,
      windowCount: 0,
    };
    connections.add(conn);
    let group = orgs.get(conn.organizationId);
    if (!group) {
      group = new Set();
      orgs.set(conn.organizationId, group);
    }
    group.add(conn);
    totalConnected += 1;
    ws.on("message", (data, isBinary) => onClientMessage(conn, data, isBinary));
    ws.on("error", () => ws.terminate());
    ws.on("close", () => onConnectionClosed(conn));
    log("info", "ws_connected", { active: connections.size });
    void activate(conn);
  }

  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy) {
      const header = req.headers["x-forwarded-for"];
      const joined = Array.isArray(header) ? header.join(",") : header;
      // o proxy confiável ACRESCENTA o IP real ao fim da lista; o resto pode ser forjado pelo cliente
      const last = joined?.split(",").pop()?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function increment(map: Map<string, number>, key: string) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  function decrement(map: Map<string, number>, key: string) {
    const next = (map.get(key) ?? 1) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  async function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    const path = (req.url ?? "").split("?")[0];
    if (path !== WS_PATH) return rejectHttp(socket, 404, "Not Found");
    if (shuttingDown) return rejectHttp(socket, 503, "Service Unavailable");
    if (req.headers.upgrade?.toLowerCase() !== "websocket") return rejectHttp(socket, 400, "Bad Request");

    // 1) Origin: só o front conhecido. Navegador sempre manda; ausente também é recusado.
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) return rejectHttp(socket, 403, "Forbidden");

    // 2) Limite por IP (conta também as validações em andamento, para um flood não martelar a API).
    const ip = clientIp(req);
    if ((ipCounts.get(ip) ?? 0) >= config.maxConnectionsPerIp) return rejectHttp(socket, 429, "Too Many Requests");
    increment(ipCounts, ip);
    let reservedUser: string | undefined;
    let aborted = false;
    socket.once("close", () => {
      aborted = true;
      decrement(ipCounts, ip);
      if (reservedUser !== undefined) decrement(userCounts, reservedUser);
    });

    // 3) Sessão: pergunta à API com o cookie do navegador. Empresa e usuário vêm SÓ daqui.
    const cookie = req.headers.cookie ?? "";
    let check: SessionCheck;
    try {
      check = await validateSession(cookie);
    } catch {
      check = { kind: "unavailable" };
    }
    if (aborted) return;
    if (shuttingDown) return rejectHttp(socket, 503, "Service Unavailable");
    if (check.kind === "unavailable") return rejectHttp(socket, 503, "Service Unavailable");

    if (check.kind === "ok") {
      if ((userCounts.get(check.userId) ?? 0) >= config.maxConnectionsPerUser) return rejectHttp(socket, 429, "Too Many Requests");
      reservedUser = check.userId;
      increment(userCounts, check.userId);
    }

    // 4) Aceita o socket. Sessão inválida/suspensa é aceita só para entregar o código de fechamento ao navegador
    //    (4401/4402); nada é assinado nem enviado nesse caso.
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => ws.terminate());
      if (check.kind === "ok") register(ws, check, cookie);
      else if (check.kind === "suspended") ws.close(realtimeCloseCodes.suspended, "suspended");
      else ws.close(realtimeCloseCodes.unauthorized, "unauthorized");
    });
  }

  httpServer.on("upgrade", (req, socket, head) => {
    void onUpgrade(req, socket, head).catch(() => {
      log("error", "realtime_upgrade_failed");
      rejectHttp(socket, 500, "Internal Server Error");
    });
  });

  // ───────────────────────── heartbeat e revalidação ─────────────────────────

  function runHeartbeat() {
    const t = now();
    for (const conn of [...connections]) {
      if (t - conn.lastPongAt > config.pongTimeoutMs) {
        conn.ws.terminate();
        continue;
      }
      if (conn.ready) send(conn, { type: "ping" });
    }
  }

  async function revalidateOne(conn: Connection) {
    let check: SessionCheck;
    try {
      check = await validateSession(conn.cookie);
    } catch {
      return; // na dúvida mantém: queda da API não derruba ninguém
    }
    if (!connections.has(conn)) return;
    if (check.kind === "unauthorized") closeConnection(conn, realtimeCloseCodes.unauthorized, "unauthorized");
    else if (check.kind === "suspended") closeConnection(conn, realtimeCloseCodes.suspended, "suspended");
    else if (check.kind === "ok" && (check.organizationId !== conn.organizationId || check.userId !== conn.userId)) {
      // a pessoa trocou de empresa ativa: reconecta já na empresa certa
      closeConnection(conn, realtimeCloseCodes.unauthorized, "unauthorized");
    }
  }

  async function runRevalidation() {
    if (revalidating) return;
    revalidating = true;
    try {
      const queue = [...connections];
      const worker = async () => {
        for (let conn = queue.shift(); conn; conn = queue.shift()) await revalidateOne(conn);
      };
      await Promise.all(Array.from({ length: Math.min(REVALIDATE_CONCURRENCY, queue.length) }, worker));
    } finally {
      revalidating = false;
    }
  }

  // ───────────────────────── ciclo de vida ─────────────────────────

  async function listen(port = config.port): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, config.host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    heartbeatTimer = setInterval(runHeartbeat, config.pingIntervalMs);
    revalidateTimer = setInterval(() => void runRevalidation(), config.revalidateIntervalMs);
    heartbeatTimer.unref();
    revalidateTimer.unref();
    const address = httpServer.address();
    return typeof address === "object" && address ? address.port : port;
  }

  async function close() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (revalidateTimer) clearInterval(revalidateTimer);
    const open = [...connections];
    for (const conn of open) closeConnection(conn, realtimeCloseCodes.serverShuttingDown, "server_shutting_down");
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + SHUTDOWN_GRACE_MS;
      const poll = setInterval(() => {
        if (open.every((conn) => conn.ws.readyState === WebSocket.CLOSED) || Date.now() > deadline) {
          clearInterval(poll);
          resolve();
        }
      }, 25);
    });
    for (const conn of open) conn.ws.terminate();
    wss.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeAllConnections();
    });
    await subscriber.quit().catch(() => undefined);
    log("info", "realtime_stopped");
  }

  return {
    listen,
    close,
    runHeartbeat,
    runRevalidation,
    httpServer,
    stats: () => ({
      connections: connections.size,
      organizations: orgs.size,
      subscribedChannels: subscribed.size,
      totalConnected,
      totalDisconnected,
      droppedInvalid,
      droppedForged,
    }),
  };
}
