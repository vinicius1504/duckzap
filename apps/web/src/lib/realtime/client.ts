import type { RealtimeEvent } from "@duckzap/contracts/realtime";
import { browserTimers, type TimerApi } from "./coalesce";
import { backoffDelay, closePolicy, createDedupe, parseServerMessage, type CloseDecision } from "./protocol";

export type RealtimeStatus = "connecting" | "online" | "offline";

/** Um aviso já validado e sem repetição. */
export type RealtimeNotice = { id: string; at: string; event: RealtimeEvent };

export type FatalReason = Extract<CloseDecision, { action: "stop" }>["reason"];

export type SocketHandlers = {
  onOpen(): void;
  onMessage(data: unknown): void;
  onClose(code: number): void;
};
export type SocketHandle = { send(data: string): void; close(code?: number): void };
/** Abre uma conexão. Em produção é o `new WebSocket` (ver `browser.ts`); nos testes é um falso. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketHandle;

export type PageSignal = "visible" | "hidden" | "online" | "offline";
export type PageEnv = {
  isHidden(): boolean;
  subscribe(listener: (signal: PageSignal) => void): () => void;
};

export type RealtimeClientOptions = {
  /** `null` = tempo real não configurado (o cliente fica offline e não tenta nada) */
  url: string | (() => string | null);
  createSocket: SocketFactory;
  timers?: TimerApi;
  page?: PageEnv;
  random?: () => number;
  /** aba escondida por tanto tempo → fecha a conexão (volta ao reabrir a aba) */
  hiddenPauseMs?: number;
  /** sem nenhuma mensagem do servidor por tanto tempo → considera a conexão morta (o servidor manda ping a cada 25 s) */
  staleMs?: number;
  dedupeSize?: number;
};

const NO_PAGE: PageEnv = { isHidden: () => false, subscribe: () => () => {} };

/**
 * Conexão com o servidor de tempo real. Classe simples, sem React nem navegador:
 * o `WebSocket`, os timers e os sinais da página (aba visível/escondida, rede) são injetados.
 *
 * Ciclo: `start()` abre; cai → espera (backoff com jitter) e reabre; `stop()` fecha e desiste (pode chamar `start()` de novo,
 * o React StrictMode monta, desmonta e monta outra vez). Códigos 4401/4402/4403 encerram sem reconectar (`onFatal`).
 */
export class RealtimeClient {
  private readonly urlOf: () => string | null;
  private readonly createSocket: SocketFactory;
  private readonly timers: TimerApi;
  private readonly page: PageEnv;
  private readonly random: () => number;
  private readonly hiddenPauseMs: number;
  private readonly staleMs: number;
  private readonly dedupe;

  private status: RealtimeStatus = "connecting";
  private running = false;
  private paused = false;
  private fatal: FatalReason | null = null;
  private attempt = 0;
  /** houve queda (ou tentativa que falhou) desde o último `ready`: ao voltar, o front precisa se atualizar */
  private needsResync = false;
  private current: { socket: SocketHandle | null } | null = null;
  private retryTimer: unknown = null;
  private staleTimer: unknown = null;
  private pauseTimer: unknown = null;
  private unsubscribePage: (() => void) | null = null;

  private readonly noticeListeners = new Set<(notice: RealtimeNotice) => void>();
  private readonly statusListeners = new Set<() => void>();
  private readonly resyncListeners = new Set<() => void>();
  private readonly fatalListeners = new Set<(reason: FatalReason, code: number) => void>();

  constructor(options: RealtimeClientOptions) {
    this.urlOf = typeof options.url === "function" ? options.url : () => options.url as string;
    this.createSocket = options.createSocket;
    this.timers = options.timers ?? browserTimers;
    this.page = options.page ?? NO_PAGE;
    this.random = options.random ?? Math.random;
    this.hiddenPauseMs = options.hiddenPauseMs ?? 10 * 60_000;
    this.staleMs = options.staleMs ?? 70_000;
    this.dedupe = createDedupe(options.dedupeSize ?? 200);
  }

  // ---- API pública -------------------------------------------------------------------------------

  getStatus = (): RealtimeStatus => this.status;

  /** Motivo do encerramento definitivo (4401/4402/4403), se houve. */
  getFatal = (): FatalReason | null => this.fatal;

  subscribe = (listener: (notice: RealtimeNotice) => void): (() => void) => {
    this.noticeListeners.add(listener);
    return () => void this.noticeListeners.delete(listener);
  };

  /** Compatível com `useSyncExternalStore`. */
  onStatus = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => void this.statusListeners.delete(listener);
  };

  /** Chamado quando a conexão volta depois de uma queda: pode ter perdido avisos, então atualize. */
  onResync = (listener: () => void): (() => void) => {
    this.resyncListeners.add(listener);
    return () => void this.resyncListeners.delete(listener);
  };

  onFatal = (listener: (reason: FatalReason, code: number) => void): (() => void) => {
    this.fatalListeners.add(listener);
    return () => void this.fatalListeners.delete(listener);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.fatal = null;
    this.attempt = 0;
    this.unsubscribePage = this.page.subscribe((signal) => this.onPageSignal(signal));
    if (this.page.isHidden()) this.armPauseTimer();
    this.connect();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.unsubscribePage?.();
    this.unsubscribePage = null;
    this.clearTimers();
    this.closeCurrent();
    this.dedupe.clear();
    this.needsResync = false;
    this.setStatus("offline");
  }

  // ---- conexão -----------------------------------------------------------------------------------

  private connect(): void {
    if (!this.running || this.paused || this.fatal || this.current) return;
    const url = this.urlOf();
    if (!url) {
      this.setStatus("offline");
      return;
    }
    this.setStatus("connecting");
    const conn: { socket: SocketHandle | null } = { socket: null };
    this.current = conn;
    const live = () => this.current === conn;
    try {
      conn.socket = this.createSocket(url, {
        onOpen: () => {
          if (live()) this.armStaleTimer();
        },
        onMessage: (data) => {
          if (live()) this.handleMessage(conn, data);
        },
        onClose: (code) => {
          if (live()) this.handleClose(code);
        },
      });
    } catch {
      // URL inválida, CSP bloqueando… tratamos como queda sem código
      if (live()) this.handleClose(1006);
      return;
    }
    // o servidor pode ter fechado de forma síncrona (fábricas de teste): nada a fazer
    if (live()) this.armStaleTimer();
  }

  private handleMessage(conn: { socket: SocketHandle | null }, data: unknown): void {
    this.armStaleTimer();
    const message = parseServerMessage(data);
    if (!message) return;
    switch (message.type) {
      case "ready": {
        this.attempt = 0;
        this.setStatus("online");
        if (this.needsResync) {
          this.needsResync = false;
          for (const listener of [...this.resyncListeners]) listener();
        }
        return;
      }
      case "ping": {
        try {
          conn.socket?.send(JSON.stringify({ type: "pong" }));
        } catch {
          // a conexão já está caindo; o onClose cuida
        }
        return;
      }
      case "event": {
        if (this.dedupe.seen(message.id)) return;
        const notice: RealtimeNotice = { id: message.id, at: message.at, event: message.event };
        for (const listener of [...this.noticeListeners]) listener(notice);
        return;
      }
    }
  }

  private handleClose(code: number): void {
    this.current = null;
    this.clearTimer("stale");
    const decision = closePolicy(code);
    if (decision.action === "stop") {
      this.fatal = decision.reason;
      this.clearTimer("retry");
      this.setStatus("offline");
      for (const listener of [...this.fatalListeners]) listener(decision.reason, code);
      return;
    }
    this.needsResync = true;
    this.setStatus("offline");
    if (this.paused) return;
    const wait = backoffDelay(this.attempt, this.random);
    this.attempt += 1;
    this.clearTimer("retry");
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, wait);
  }

  /** Reabre já, sem esperar o backoff (aba voltou, rede voltou). */
  private reconnectNow(): void {
    if (!this.running || this.fatal || this.status === "online") return;
    this.paused = false;
    this.attempt = 0;
    this.clearTimer("retry");
    // tentativa em andamento (connecting): deixa terminar
    if (this.current) return;
    this.needsResync = true;
    this.connect();
  }

  private onPageSignal(signal: PageSignal): void {
    switch (signal) {
      case "hidden":
        this.armPauseTimer();
        return;
      case "visible":
        this.clearTimer("pause");
        this.reconnectNow();
        return;
      case "online":
        this.reconnectNow();
        return;
      case "offline":
        // nada a fazer: a conexão cai sozinha e o "online" dispara a reconexão imediata
        return;
    }
  }

  private armPauseTimer(): void {
    this.clearTimer("pause");
    this.pauseTimer = this.timers.setTimeout(() => {
      this.pauseTimer = null;
      if (!this.running || !this.page.isHidden()) return;
      this.paused = true;
      this.clearTimer("retry");
      this.closeCurrent();
      this.needsResync = true;
      this.setStatus("offline");
    }, this.hiddenPauseMs);
  }

  private armStaleTimer(): void {
    this.clearTimer("stale");
    this.staleTimer = this.timers.setTimeout(() => {
      this.staleTimer = null;
      // silêncio demais: derruba e deixa o fluxo normal de queda reabrir
      if (!this.current) return;
      this.closeCurrent();
      this.handleClose(1006);
    }, this.staleMs);
  }

  // ---- utilidades --------------------------------------------------------------------------------

  private closeCurrent(): void {
    const conn = this.current;
    this.current = null; // antes de fechar: o onClose desta conexão passa a ser ignorado
    this.clearTimer("stale");
    if (!conn?.socket) return;
    try {
      conn.socket.close(1000);
    } catch {
      // já fechado
    }
  }

  private clearTimer(which: "retry" | "stale" | "pause"): void {
    const key = which === "retry" ? "retryTimer" : which === "stale" ? "staleTimer" : "pauseTimer";
    if (this[key] !== null) this.timers.clearTimeout(this[key]);
    this[key] = null;
  }

  private clearTimers(): void {
    this.clearTimer("retry");
    this.clearTimer("stale");
    this.clearTimer("pause");
  }

  private setStatus(next: RealtimeStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of [...this.statusListeners]) listener();
  }
}
