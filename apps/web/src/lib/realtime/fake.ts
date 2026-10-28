import type { TimerApi } from "./coalesce";
import type { PageEnv, PageSignal, SocketFactory, SocketHandle, SocketHandlers } from "./client";

/** Apoio de teste: relógio manual, WebSocket falso e página falsa. Não é importado pelo app. */
export class FakeClock implements TimerApi {
  now = 0;
  private seq = 0;
  private tasks = new Map<number, { at: number; fn: () => void }>();

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };
  get pending(): number {
    return this.tasks.size;
  }
  /** Avança o relógio executando, em ordem, o que vencer. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, task] of this.tasks) {
        if (task.at <= target && task.at < nextAt) {
          nextAt = task.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const task = this.tasks.get(nextId);
      this.tasks.delete(nextId);
      this.now = nextAt;
      task?.fn();
    }
    this.now = target;
  }
}

export class FakeSocket implements SocketHandle {
  sent: string[] = [];
  closedWith: number | null | undefined = undefined;
  constructor(
    readonly url: string,
    readonly handlers: SocketHandlers,
  ) {}
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code ?? null;
  }
  // ---- o que o servidor faria
  open() {
    this.handlers.onOpen();
  }
  receive(message: unknown) {
    this.handlers.onMessage(typeof message === "string" ? message : JSON.stringify(message));
  }
  serverClose(code: number) {
    this.handlers.onClose(code);
  }
}

export function fakeSocketFactory() {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = (url, handlers) => {
    const socket = new FakeSocket(url, handlers);
    sockets.push(socket);
    return socket;
  };
  return {
    factory,
    sockets,
    get last(): FakeSocket {
      const socket = sockets[sockets.length - 1];
      if (!socket) throw new Error("nenhum socket aberto");
      return socket;
    },
  };
}

export class FakePage implements PageEnv {
  hidden = false;
  private listeners = new Set<(signal: PageSignal) => void>();
  isHidden = () => this.hidden;
  subscribe = (listener: (signal: PageSignal) => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  get listenerCount() {
    return this.listeners.size;
  }
  emit(signal: PageSignal) {
    if (signal === "hidden") this.hidden = true;
    if (signal === "visible") this.hidden = false;
    for (const listener of [...this.listeners]) listener(signal);
  }
}
