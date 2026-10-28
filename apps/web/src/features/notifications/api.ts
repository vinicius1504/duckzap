import "server-only";
import { notificationListSchema, type MarkNotificationsRead, type NotificationList } from "@duckzap/contracts/notifications";
import { z } from "zod";
import { get, send, toResult, type CommonError } from "@/lib/api-result";
import type { Result } from "@/lib/mock";

// Ligado ao back (apps/api · modules/notifications): GET /v1/notifications (só as da própria pessoa, até 30, mais novas
// primeiro) e POST /v1/notifications/read ({ all: true } ou { ids }). Só exigem sessão.

const markedSchema = z.object({ ok: z.literal(true), unreadCount: z.number().int().min(0) });

/** Resposta fora do formato vira falha (`unavailable`), nunca exceção: o sino não pode derrubar a tela. */
export async function listNotifications(): Promise<Result<NotificationList, CommonError>> {
  try {
    return toResult(await get("/v1/notifications"), notificationListSchema, []);
  } catch {
    return { ok: false, error: "unavailable", message: "A resposta do servidor veio em um formato inesperado." };
  }
}

/** Contador do topo. Qualquer falha vira 0: o topo nunca pode quebrar a página. */
export async function getUnreadNotificationCount(): Promise<number> {
  const result = await listNotifications();
  return result.ok ? result.data.unreadCount : 0;
}

export async function markNotificationsRead(target: MarkNotificationsRead): Promise<Result<{ unreadCount: number }, CommonError>> {
  try {
    const result = toResult(await send("POST", "/v1/notifications/read", target), markedSchema, []);
    return result.ok ? { ok: true, data: { unreadCount: result.data.unreadCount } } : result;
  } catch {
    return { ok: false, error: "unavailable", message: "A resposta do servidor veio em um formato inesperado." };
  }
}
