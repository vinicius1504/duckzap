/**
 * Aviso de "digitando…" do campo de resposta: o primeiro toque numa sequência avisa na hora e, enquanto a pessoa continua
 * digitando, renova a cada `intervalMs` (~4 s: o servidor também limita). Parar de digitar não avisa nada (o "digitando…"
 * some sozinho no WhatsApp); `stop()` (enviar, sair do campo, apagar tudo, virar nota) faz o próximo toque avisar de novo
 * imediatamente. Sem timers: só reage a digitação, então não deixa nada rodando em segundo plano.
 */
export const TYPING_PING_INTERVAL_MS = 4000;

export type TypingPinger = {
  /** Chame a cada alteração do texto feita pela pessoa. `enabled=false` (nota interna, envio pausado, IA respondendo) não avisa. Devolve se avisou. */
  input(text: string, enabled?: boolean): boolean;
  stop(): void;
};

export function createTypingPinger(options: { send: () => void; intervalMs?: number; now?: () => number }): TypingPinger {
  const interval = options.intervalMs ?? TYPING_PING_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let last: number | null = null;
  return {
    input(text, enabled = true) {
      if (!enabled || text.trim() === "") {
        last = null;
        return false;
      }
      const at = now();
      if (last !== null && at - last < interval) return false;
      last = at;
      options.send();
      return true;
    },
    stop() {
      last = null;
    },
  };
}
