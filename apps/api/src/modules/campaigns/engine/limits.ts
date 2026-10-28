import { SAFE_LIMITS, splitIntoDays, warmupDailyLimit } from "@duckzap/contracts/campaigns";

// Limites duros do §5.7 item 2. Funções puras: o servidor aplica; a UI só mostra.

export const OFFICIAL_LIMITS = { daily: 1000, hourly: 1000 } as const;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export type ChannelKindLike = "whatsapp_qr" | "whatsapp_official";

/** Dia de uso do número (1 = dia em que foi criado/conectado), contado em dias corridos. */
export function numberAgeDays(connectedSince: Date, now: Date) {
  return Math.max(1, Math.floor((now.getTime() - connectedSince.getTime()) / DAY_MS) + 1);
}

/** Limite diário de CAMPANHA do número: QR → aquecimento 10/25/50; oficial → teto alto (a Meta limita por camada). */
export function dailyLimitFor(kind: ChannelKindLike, ageDays: number) {
  return kind === "whatsapp_qr" ? warmupDailyLimit(ageDays) : OFFICIAL_LIMITS.daily;
}

export function hourlyLimitFor(kind: ChannelKindLike) {
  return kind === "whatsapp_qr" ? SAFE_LIMITS.hourlyMax : OFFICIAL_LIMITS.hourly;
}

export type UsageSnapshot = {
  /** Mensagens de campanha (e convites) já enviadas hoje, no fuso da empresa. */
  sentToday: number;
  /** Instantes (ms) dos envios da última hora. */
  sentTimesLastHour: readonly number[];
};

export type SendGate =
  | { allowed: true }
  | { allowed: false; reason: "daily_limit" | "hourly_limit"; retryAt: Date | null };

/**
 * Pode enviar agora? Diário esgotado: sem hora de retorno (o chamador usa o início da janela do próximo dia útil).
 * Horário esgotado: libera quando o envio mais antigo da última hora completar 1 h.
 */
export function checkSendGate(kind: ChannelKindLike, ageDays: number, usage: UsageSnapshot, now: Date): SendGate {
  if (usage.sentToday >= dailyLimitFor(kind, ageDays)) return { allowed: false, reason: "daily_limit", retryAt: null };
  const hourly = hourlyLimitFor(kind);
  const recent = usage.sentTimesLastHour.filter((t) => now.getTime() - t < HOUR_MS).sort((a, b) => a - b);
  if (recent.length >= hourly) {
    const pivot = recent[recent.length - hourly] as number;
    return { allowed: false, reason: "hourly_limit", retryAt: new Date(pivot + HOUR_MS) };
  }
  return { allowed: true };
}

/**
 * Divisão em dias respeitando o aquecimento (o limite sobe ao longo dos dias). Com o número já aquecido
 * devolve exatamente `splitIntoDays` do contrato (a mesma conta da tela); só difere para números novos.
 * `sentToday` reduz o primeiro dia; se hoje já esgotou, o primeiro dia é amanhã (limite cheio), como no contrato.
 */
export function splitWithWarmup(recipients: number, kind: ChannelKindLike, ageDays: number, sentToday: number) {
  if (kind === "whatsapp_official" || warmupDailyLimit(ageDays) === warmupDailyLimit(ageDays + 400)) {
    return splitIntoDays(recipients, dailyLimitFor(kind, ageDays), sentToday);
  }
  const days: number[] = [];
  let left = recipients;
  let offset = 0;
  if (recipients > 0 && sentToday >= dailyLimitFor(kind, ageDays)) offset = 1; // hoje esgotado
  for (let day = 0; left > 0 && day < 400; day++) {
    const limit = dailyLimitFor(kind, ageDays + offset + day);
    const room = day === 0 && offset === 0 ? Math.max(0, limit - sentToday) : limit;
    const take = Math.min(left, room);
    days.push(take);
    left -= take;
  }
  return days;
}
