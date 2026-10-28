/** Gerador de números aleatórios injetável: produção usa `Math.random`; testes usam `seeded` (determinístico). */
export type Rng = () => number;

/** mulberry32: pequeno, rápido e suficiente para testes e sorteios do motor (não é criptográfico). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomRng: Rng = () => Math.random();

/** Inteiro em [min, max] (inclusive). */
export function randInt(rng: Rng, min: number, max: number) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Fisher-Yates; devolve uma cópia. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
