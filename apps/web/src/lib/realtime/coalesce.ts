export type TimerApi = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export const browserTimers: TimerApi = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type Coalescer = {
  /** Pede uma execução. Chamadas dentro da janela viram uma só, no fim dela (borda de descida). */
  trigger(): void;
  /** Descarta a execução pendente. */
  cancel(): void;
  readonly pending: boolean;
};

/**
 * Junta rajadas: no máximo uma execução de `fn` a cada `windowMs`, sempre no fim da janela.
 * O primeiro `trigger` abre a janela; os seguintes, enquanto ela está aberta, são absorvidos.
 */
export function createCoalescer(fn: () => void, windowMs = 400, timers: TimerApi = browserTimers): Coalescer {
  let handle: unknown = null;
  let waiting = false;
  return {
    trigger() {
      if (waiting) return;
      waiting = true;
      handle = timers.setTimeout(() => {
        waiting = false;
        handle = null;
        fn();
      }, windowMs);
    },
    cancel() {
      if (!waiting) return;
      timers.clearTimeout(handle);
      waiting = false;
      handle = null;
    },
    get pending() {
      return waiting;
    },
  };
}
