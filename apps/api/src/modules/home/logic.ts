import type { TaskPriority } from "@duckzap/contracts/home";
import { shiftDay, todayIn, zonedDay, zonedTime, zonedToUtc } from "../appointments/time";

// Regras puras do Início: período, rótulos de prazo, percentuais. Sem banco.

export type Period = "today" | "7d" | "30d" | "custom";

/**
 * Janela [from, to) em UTC do filtro de período, em dias do fuso da empresa. "Hoje" = desde 00:00 local; 7d/30d = os últimos
 * N dias incluindo hoje. "custom" ainda não tem seletor de datas na tela e se comporta como 30 dias.
 */
export function periodRange(period: Period, now: Date, timeZone: string): { from: Date; to: Date; days: number; fromDay: string; toDay: string } {
  const days = period === "today" ? 1 : period === "7d" ? 7 : 30;
  const toDay = todayIn(timeZone, now);
  const fromDay = shiftDay(toDay, -(days - 1));
  return { from: new Date(zonedToUtc(fromDay, "00:00", timeZone)), to: new Date(zonedToUtc(shiftDay(toDay, 1), "00:00", timeZone)), days, fromDay, toDay };
}

/** Os últimos `count` dias terminando hoje (AAAA-MM-DD, do mais antigo ao mais novo). */
export function lastDays(count: number, now: Date, timeZone: string): string[] {
  const today = todayIn(timeZone, now);
  return Array.from({ length: count }, (_, i) => shiftDay(today, i - (count - 1)));
}

/**
 * Divide 100% entre as fatias pelo método do maior resto: números inteiros que somam exatamente 100
 * (ou tudo zero quando não há dados).
 */
export function distributePercent(counts: readonly number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  const raw = counts.map((n) => (n / total) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rest: r - Math.floor(r) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left--;
  }
  return floors;
}

export const percentOf = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function hourLabel(iso: string, timeZone: string) {
  const [h = "00", m = "00"] = zonedTime(iso, timeZone).split(":");
  return m === "00" ? `${Number(h)}h` : `${Number(h)}h${m}`;
}

function dayDiff(a: string, b: string) {
  return Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);
}

/** "Hoje, 16h" · "Amanhã, 10h" · "Sexta, 14h" · "Atrasada · 25/10" · "Sem prazo" · "Concluída hoje". */
export function dueLabel(task: { dueAt: Date | null; done: boolean; doneAt: Date | null }, now: Date, timeZone: string): string {
  const today = todayIn(timeZone, now);
  if (task.done) {
    return task.doneAt && zonedDay(task.doneAt.toISOString(), timeZone) === today ? "Concluída hoje" : "Concluída";
  }
  if (!task.dueAt) return "Sem prazo";
  const iso = task.dueAt.toISOString();
  const day = zonedDay(iso, timeZone);
  const diff = dayDiff(day, today);
  const [, m = "", d = ""] = day.split("-");
  if (diff < 0) return `Atrasada · ${d}/${m}`;
  if (diff === 0) return `Hoje, ${hourLabel(iso, timeZone)}`;
  if (diff === 1) return `Amanhã, ${hourLabel(iso, timeZone)}`;
  if (diff < 7) {
    const [y = 0, mo = 1, dd = 1] = day.split("-").map(Number);
    return `${cap(WEEKDAYS[new Date(Date.UTC(y, mo - 1, dd)).getUTCDay()] ?? "")}, ${hourLabel(iso, timeZone)}`;
  }
  return `${d}/${m}, ${hourLabel(iso, timeZone)}`;
}

/** Nome mostrado na tarefa: "Você" para a própria pessoa, o primeiro nome para as demais. */
export function assigneeLabel(assigneeId: string, viewerId: string, assigneeName: string | null): string {
  if (assigneeId === viewerId) return "Você";
  return (assigneeName ?? "Equipe").split(" ")[0] ?? "Equipe";
}

export const TASK_PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** "18 min" / "2 h" / "3 dias" para o detalhe da lista "Precisa de você". */
export function ageLabel(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} dias`;
}
