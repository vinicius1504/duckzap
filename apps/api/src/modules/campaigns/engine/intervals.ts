import { INTERVAL_FLOOR_SECONDS } from "@duckzap/contracts/campaigns";
import { MAX_TYPING_MS } from "../../../lib/messaging";
import { randInt, type Rng } from "./rng";

// §5.7 item 3: intervalo aleatório entre mín. e máx. (padrão 45–120 s, piso 30 s), distribuição IRREGULAR (não uniforme),
// nunca dois iguais seguidos; a cada 8–15 mensagens, pausa longa de 5–15 min.

export const LONG_PAUSE_EVERY = { min: 8, max: 15 } as const;
export const LONG_PAUSE_SECONDS = { min: 300, max: 900 } as const;

export type SamplerState = {
  /** Último intervalo sorteado (null antes do primeiro). */
  lastInterval: number | null;
  /** Mensagens enviadas desde a última pausa longa. */
  sinceLongPause: number;
  /** Depois de quantas mensagens vem a próxima pausa longa (8–15, sorteado). */
  longPauseAfter: number;
};

export type IntervalConfig = { minSeconds: number; maxSeconds: number };

export function initialSamplerState(rng: Rng): SamplerState {
  return { lastInterval: null, sinceLongPause: 0, longPauseAfter: randInt(rng, LONG_PAUSE_EVERY.min, LONG_PAUSE_EVERY.max) };
}

/** Limites efetivos: o piso de 30 s vale mesmo que a configuração (ou a UI) peça menos. */
export function effectiveBounds(config: IntervalConfig) {
  const min = Math.max(INTERVAL_FLOOR_SECONDS, Math.floor(config.minSeconds));
  const max = Math.max(min + 1, Math.floor(config.maxSeconds));
  return { min, max };
}

/**
 * Um sorteio, sem a regra de "diferente do anterior". Mistura:
 *  - 80%: concentrado no começo da faixa (uniforme elevado a 2,5), com um pouco de ruído;
 *  - 12%: meio da faixa;
 *  - 8%: "distraído", perto do máximo.
 * O resultado não é uniforme (média abaixo do ponto médio) e tem cauda longa até o máximo.
 */
function draw(min: number, max: number, rng: Rng) {
  const span = max - min;
  const pick = rng();
  let fraction: number;
  if (pick < 0.8) fraction = 0.9 * rng() ** 2.5 + 0.1 * rng();
  else if (pick < 0.92) fraction = 0.35 + 0.3 * rng();
  else fraction = 0.8 + 0.2 * rng();
  return Math.min(max, Math.max(min, min + Math.round(span * fraction)));
}

export type NextInterval = {
  seconds: number;
  /** Pausa longa (5–15 min) a aplicar DEPOIS desta mensagem, quando chegou a hora. */
  longPauseSeconds: number | null;
  state: SamplerState;
};

/** Chamado a cada mensagem enviada: devolve o intervalo até a próxima, e a pausa longa quando for a vez. */
export function nextInterval(config: IntervalConfig, state: SamplerState, rng: Rng): NextInterval {
  const { min, max } = effectiveBounds(config);
  let seconds = draw(min, max, rng);
  for (let attempt = 0; seconds === state.lastInterval && attempt < 12; attempt++) seconds = draw(min, max, rng);
  if (seconds === state.lastInterval) {
    // faixa estreita e azar: desloca 1–3 s para dentro da faixa, nunca igual ao anterior
    const step = randInt(rng, 1, 3);
    seconds = seconds + step <= max ? seconds + step : Math.max(min, seconds - step);
    if (seconds === state.lastInterval) seconds = seconds < max ? seconds + 1 : seconds - 1;
  }
  const sinceLongPause = state.sinceLongPause + 1;
  if (sinceLongPause >= state.longPauseAfter) {
    return {
      seconds,
      longPauseSeconds: randInt(rng, LONG_PAUSE_SECONDS.min, LONG_PAUSE_SECONDS.max),
      state: { lastInterval: seconds, sinceLongPause: 0, longPauseAfter: randInt(rng, LONG_PAUSE_EVERY.min, LONG_PAUSE_EVERY.max) },
    };
  }
  return { seconds, longPauseSeconds: null, state: { lastInterval: seconds, sinceLongPause, longPauseAfter: state.longPauseAfter } };
}

/** API oficial: sem aquecimento nem pausas longas; só um espaçamento curto com ruído para não rajadar o provedor. */
export function officialInterval(rng: Rng) {
  return randInt(rng, 1, 4);
}

/**
 * "Digitando…" proporcional ao tamanho do texto, entre 1,5 s e 8 s (~ 40 caracteres por segundo, com ruído). Vai em
 * `OutboundMessage.typingMs` (o teto é o mesmo `MAX_TYPING_MS` que o schema da mensagem aceita).
 */
export function typingDurationMs(text: string, rng: Rng) {
  const base = (text.length / 40) * 1000;
  return Math.round(Math.min(MAX_TYPING_MS, Math.max(1500, base * (0.8 + 0.4 * rng()))));
}

export function parseSamplerState(raw: unknown, rng: Rng): SamplerState {
  const fresh = initialSamplerState(rng);
  if (typeof raw !== "object" || raw === null) return fresh;
  const r = raw as Record<string, unknown>;
  const last = typeof r.lastInterval === "number" ? r.lastInterval : null;
  const since = typeof r.sinceLongPause === "number" ? r.sinceLongPause : 0;
  const after = typeof r.longPauseAfter === "number" ? r.longPauseAfter : fresh.longPauseAfter;
  return { lastInterval: last, sinceLongPause: since, longPauseAfter: after };
}
