import { splitIntoDays } from "@duckzap/contracts/campaigns";
import { addDays, localDate, nextSendDay, nextWindowOpening, type SendWindow } from "./calendar";
import { dailyLimitFor, splitWithWarmup, type ChannelKindLike } from "./limits";

export type DayPlanInput = {
  /** Quantas pessoas ainda faltam enviar. */
  count: number;
  kind: ChannelKindLike;
  /** Idade do número HOJE (dia 1 = primeiro dia). */
  ageDays: number;
  /** Já enviado hoje por este número (todas as campanhas e convites). */
  sentToday: number;
  /** Instante de partida: agora, ou a data agendada se for no futuro. */
  from: Date;
  now: Date;
  window: SendWindow;
};

/**
 * Divisão automática em dias (§5.7 item 2): "64 pessoas → 2 dias (50 + 14)". Usa `splitIntoDays` do contrato (mesma conta
 * da tela) e coloca cada dia numa data permitida (sem domingo/feriado quando pedido, a partir da abertura da janela).
 * Hoje já esgotado ou fora da janela → começa no próximo dia/abertura.
 */
export function projectDayPlan(input: DayPlanInput): { date: string; count: number }[] {
  if (input.count <= 0) return [];
  const { window, now } = input;
  const today = localDate(now, window.timeZone);
  const start = input.from.getTime() > now.getTime() ? input.from : now;
  let startDate = localDate(nextWindowOpening(start, window), window.timeZone);
  if (startDate === today && input.sentToday >= dailyLimitFor(input.kind, input.ageDays)) {
    startDate = nextSendDay(addDays(today, 1), window.skipSundaysAndHolidays);
  }
  const daysAhead = Math.round((Date.parse(`${startDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  const counts = splitWithWarmup(input.count, input.kind, input.ageDays + daysAhead, startDate === today ? input.sentToday : 0);
  const plan: { date: string; count: number }[] = [];
  let date = startDate;
  for (const count of counts) {
    date = nextSendDay(date, window.skipSundaysAndHolidays);
    plan.push({ date, count });
    date = addDays(date, 1);
  }
  return plan;
}

export { splitIntoDays };
