import { scheduleDays } from "@duckzap/contracts/campaigns";
import { splitIntoDays } from "@duckzap/contracts/contacts";

export type InvitePlanInput = {
  count: number;
  invitesSentToday: number;
  messagesSentToday: number;
  inviteDailyLimit: number;
  channelDailyLimit: number;
  /** Hoje (AAAA-MM-DD) no fuso da empresa. */
  today: string;
  /** Sem domingos por padrão. */
  skipSundays: boolean;
};

export type InvitePlan = {
  /** Quantos por dia a partir de hoje (ex.: [20, 14]; o primeiro pode ser 0 se hoje já esgotou). */
  days: number[];
  /** Dias reais de envio, já sem domingos e sem dias vazios. */
  schedule: { date: string; count: number }[];
  dailyLimit: number;
  remainingToday: number;
};

const isSunday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay() === 0;

/**
 * Divide os convites por dia: até 20/dia por número, dentro do teto diário do canal (que já considera o
 * aquecimento), descontando o que já saiu hoje. Reaproveita `splitIntoDays`/`scheduleDays` dos contratos.
 */
export function planInvites(input: InvitePlanInput): InvitePlan {
  const dailyLimit = Math.max(0, Math.min(input.inviteDailyLimit, input.channelDailyLimit));
  const todayUsable = !(input.skipSundays && isSunday(input.today));
  const remainingToday = todayUsable
    ? Math.max(0, Math.min(input.inviteDailyLimit - input.invitesSentToday, input.channelDailyLimit - input.messagesSentToday))
    : 0;
  // hoje sem envio (domingo): o primeiro dia útil já começa com o limite cheio
  const days = splitIntoDays(input.count, todayUsable ? remainingToday : dailyLimit, dailyLimit);
  const schedule = scheduleDays(days, input.today, input.skipSundays).filter((d) => d.count > 0);
  return { days, schedule, dailyLimit, remainingToday };
}

/** Reparte os ids (na ordem recebida) pelos dias do plano. */
export function assignToDays<T>(items: readonly T[], schedule: readonly { date: string; count: number }[]) {
  const out: { date: string; items: T[] }[] = [];
  let offset = 0;
  for (const day of schedule) {
    out.push({ date: day.date, items: items.slice(offset, offset + day.count) });
    offset += day.count;
  }
  return out;
}
