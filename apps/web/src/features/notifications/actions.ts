"use server";

import { markNotificationsReadSchema, type NotificationList } from "@duckzap/contracts/notifications";
import { requireSession } from "@/features/auth/session";
import { listNotifications, markNotificationsRead } from "./api";

// Server Actions finas, chamadas pelo sino. Sem `revalidatePath` de propósito: notificação não pode recarregar a tela
// inteira; o sino guarda o próprio estado e busca só a lista.

export type NotificationsActionResult = { ok: true; data: NotificationList } | { ok: false; message: string };

export async function listNotificationsAction(): Promise<NotificationsActionResult> {
  await requireSession();
  const result = await listNotifications();
  return result.ok ? { ok: true, data: result.data } : { ok: false, message: result.message };
}

/** `{ unreadCount }` quando deu certo; `{ error }` quando não. */
export async function markNotificationsReadAction(input: unknown): Promise<{ unreadCount: number } | { error: string }> {
  await requireSession();
  const parsed = markNotificationsReadSchema.safeParse(input);
  if (!parsed.success) return { error: "Não foi possível marcar como lida." };
  const result = await markNotificationsRead(parsed.data);
  return result.ok ? { unreadCount: result.data.unreadCount } : { error: result.message };
}
