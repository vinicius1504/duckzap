import type { NotificationKind, NotificationList } from "@duckzap/contracts/notifications";
import { DEFAULT_TIME_ZONE } from "./format";

// Regras puras do sino de notificações (sem React nem rede): contador, texto de acessibilidade, "há 5 min" e a
// mesclagem do que o usuário acabou de marcar como lido com a lista que veio do servidor.

/** Contador no sino: "3", "99+". Zero não mostra nada (string vazia). */
export function formatBadge(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  const n = Math.floor(count);
  return n > 99 ? "99+" : String(n);
}

/** `aria-label` do botão do sino. */
export function bellLabel(unread: number): string {
  const n = Number.isFinite(unread) ? Math.max(0, Math.floor(unread)) : 0;
  if (n === 0) return "Notificações";
  return n === 1 ? "Notificações, 1 nova" : `Notificações, ${n} novas`;
}

/** Texto do anúncio educado (aria-live) quando o contador muda. Vazio = nada a anunciar. */
export function unreadAnnouncement(unread: number): string {
  const n = Number.isFinite(unread) ? Math.max(0, Math.floor(unread)) : 0;
  if (n === 0) return "";
  return n === 1 ? "1 notificação não lida" : `${n} notificações não lidas`;
}

/** Ícone por tipo (nomes de `@duckzap/ui`). */
export function notificationIcon(kind: NotificationKind): "calendar" | "refresh" | "close" {
  switch (kind) {
    case "appointment_booked":
      return "calendar";
    case "appointment_rescheduled":
      return "refresh";
    case "appointment_canceled":
      return "close";
  }
}

type Zoned = { y: number; m: number; d: number; h: number; min: number };

function zoned(date: Date, timeZone: string): Zoned {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute") };
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayNumber = (z: Zoned) => Math.round(Date.UTC(z.y, z.m - 1, z.d) / 86_400_000);

/**
 * Tempo relativo curto, no fuso da empresa: "agora", "há 5 min", "há 3 h", "ontem 14:20", "29/10 14:20" e, em
 * outro ano, "29/10/2025". Data inválida devolve "".
 */
export function relativeTime(iso: string, now: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diffMin = Math.floor((now.getTime() - then.getTime()) / 60_000);
  // relógio do aparelho adiantado em relação ao servidor cai aqui também
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `há ${diffMin} min`;

  let t: Zoned;
  let n: Zoned;
  try {
    t = zoned(then, timeZone);
    n = zoned(now, timeZone);
  } catch {
    // fuso desconhecido: usa o padrão em vez de quebrar o topo
    t = zoned(then, DEFAULT_TIME_ZONE);
    n = zoned(now, DEFAULT_TIME_ZONE);
  }
  const days = dayNumber(n) - dayNumber(t);
  const clock = `${pad(t.h)}:${pad(t.min)}`;
  if (days <= 0) return `há ${Math.floor(diffMin / 60)} h`;
  if (days === 1) return `ontem ${clock}`;
  const date = `${pad(t.d)}/${pad(t.m)}`;
  return t.y === n.y ? `${date} ${clock}` : `${date}/${t.y}`;
}

/** O que se quer marcar como lido: tudo ou alguns ids. */
export type ReadTarget = { all?: boolean; ids?: Iterable<string> };

/**
 * Marca como lidas na lista local (otimista). `unreadCount` cai só pelas que estavam não lidas e visíveis na lista;
 * `all` zera. As que já estavam lidas não contam duas vezes.
 */
export function markRead(list: NotificationList, target: ReadTarget): NotificationList {
  if (target.all) return { items: list.items.map((i) => (i.read ? i : { ...i, read: true })), unreadCount: 0 };
  const ids = new Set(target.ids ?? []);
  if (ids.size === 0) return list;
  let changed = 0;
  const items = list.items.map((i) => {
    if (i.read || !ids.has(i.id)) return i;
    changed += 1;
    return { ...i, read: true };
  });
  return changed === 0 ? list : { items, unreadCount: Math.max(0, list.unreadCount - changed) };
}

/**
 * Lista que chegou do servidor + leituras ainda em andamento. Sem isso, uma busca que termina entre o clique e a
 * resposta de "marcar como lida" faria a notificação voltar a aparecer como não lida por um instante.
 */
export function reconcile(fromServer: NotificationList, pending: { all: boolean; ids: ReadonlySet<string> }): NotificationList {
  return markRead(fromServer, pending.all ? { all: true } : { ids: pending.ids });
}
