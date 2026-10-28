import "server-only";
import { getChannelsOverview } from "@/features/channels/api";
import { getUnreadNotificationCount } from "@/features/notifications/api";

// Status mostrado no topo do app. Lê os canais pelo módulo de Canais e o contador do sino pelo de Notificações
// (GET /v1/notifications; se falhar, 0). Depois: GET /v1/shell/status.

export type ShellStatus = { disconnectedChannels: number; unreadNotifications: number };

export async function getShellStatus(): Promise<ShellStatus> {
  const [{ channels }, unreadNotifications] = await Promise.all([getChannelsOverview(), getUnreadNotificationCount()]);
  const disconnectedChannels = channels.filter((c) => c.status === "disconnected" || c.status === "banned").length;
  return { disconnectedChannels, unreadNotifications };
}
