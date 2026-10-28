/**
 * Som de nova mensagem: um "blip" curto gerado pelo navegador (sem arquivo de áudio). Desligado por padrão;
 * a preferência fica no `localStorage` (por navegador). Todo acesso ao storage e ao áudio é protegido:
 * modo privado, storage bloqueado e política de autoplay não podem quebrar a tela.
 */
const KEY = "duckchat:realtime-sound";
const CHANGE_EVENT = "duckchat:realtime-sound-change";

let memoryFallback = false;

export function writeSoundEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    // sem storage: vale só até recarregar
    memoryFallback = enabled;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function getSoundEnabledSnapshot(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return memoryFallback;
  }
}

/** Para `useSyncExternalStore`: avisa mudanças feitas nesta aba e em outras. */
export function subscribeSoundEnabled(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

type AudioContextCtor = typeof AudioContext;
let context: AudioContext | null = null;
let lastPlayedAt = 0;

function audioContext(): AudioContext | null {
  try {
    if (context) return context;
    const Ctor: AudioContextCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    return context;
  } catch {
    return null;
  }
}

/** Chame dentro de um clique (ao ligar o som): navegadores só liberam o áudio depois de um gesto. */
export function primeSound(): void {
  const ctx = audioContext();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
}

/** Toca o blip (no máximo um a cada 2 s). Se o navegador não deixar, fica em silêncio. */
export function playMessageSound(): void {
  const now = Date.now();
  if (now - lastPlayedAt < 2000) return;
  const ctx = audioContext();
  if (!ctx || ctx.state !== "running") return;
  lastPlayedAt = now;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1175, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.24);
  } catch {
    // sem áudio: tudo bem
  }
}
