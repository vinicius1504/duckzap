import type { RealtimeEvent } from "@duckzap/contracts/realtime";

type EventType = RealtimeEvent["type"];

/**
 * Quais avisos atualizam qual tela (via `router.refresh()`, que re-busca o dado no servidor e mantém o estado do cliente:
 * rascunho, conversa aberta, rolagem, diálogos). Tela fora desta lista não é atualizada por evento.
 */
type Rule = {
  base: string;
  types: readonly EventType[];
  /** adia o refresh enquanto houver um diálogo aberto (ex.: o passo a passo do QR Code não pode sumir no meio) */
  deferWhileDialogOpen?: boolean;
};

const RULES: ReadonlyArray<Rule> = [
  // `channel.status`: o aviso "canal desconectado" da conversa e da lista também depende dele
  { base: "/conversas", types: ["conversation.message", "conversation.updated", "message.status", "channel.status"] },
  { base: "/inicio", types: ["home.invalidate"] },
  { base: "/canais", types: ["channel.status"], deferWhileDialogOpen: true },
  { base: "/agenda", types: ["home.invalidate"] },
];

export type RefreshRule = { base: string; types: ReadonlySet<EventType>; deferWhileDialogOpen: boolean };

export function refreshRuleFor(pathname: string | null): RefreshRule | null {
  if (!pathname) return null;
  const rule = RULES.find((r) => pathname === r.base || pathname.startsWith(`${r.base}/`));
  return rule ? { base: rule.base, types: new Set(rule.types), deferWhileDialogOpen: rule.deferWhileDialogOpen ?? false } : null;
}

/** Telas que, sem tempo real, se atualizam sozinhas de tempos em tempos. */
export function shouldPoll(pathname: string | null): boolean {
  const rule = refreshRuleFor(pathname);
  return rule !== null && rule.base !== "/agenda";
}

/** Conversa aberta na tela, a partir da rota e do `?conversa=`. No quadro (`?visao=quadro`) nenhuma está aberta. */
export function openConversationId(pathname: string | null, params: { get(name: string): string | null }): string | null {
  if (!pathname || !(pathname === "/conversas" || pathname.startsWith("/conversas/"))) return null;
  if (params.get("visao") === "quadro") return null;
  return params.get("conversa");
}
