import { can, type Permission } from "@duckzap/contracts/permissions";
import type { MemberRole } from "@duckzap/contracts/session";
import type { NavConfig, NavItem } from "@duckzap/ui/shell";

type WebNavItem = NavItem & { permission?: Permission };

export const webNav = {
  homeHref: "/inicio",
  moreHref: "/mais",
  items: [
    { href: "/inicio", label: "Início", icon: "home", mobile: "tab" },
    { href: "/conversas", label: "Conversas", icon: "chat", mobile: "tab" },
    { href: "/clientes", label: "Clientes", icon: "contacts", mobile: "tab" },
    { href: "/agenda", label: "Agenda", icon: "calendar", mobile: "tab" },
    { href: "/campanhas", label: "Campanhas", icon: "send", permission: "campaign.manage" },
    { href: "/agentes", label: "Agentes", icon: "bot", permission: "agent.manage" },
    { href: "/canais", label: "Canais", icon: "link", permission: "channel.manage" },
    { href: "/equipe", label: "Equipe", icon: "user", permission: "team.manage" },
    // todos entram em Ajustes (Minha conta); as abas da empresa checam permissão
    { href: "/ajustes", label: "Ajustes", icon: "sliders" },
    { href: "/ajuda", label: "Ajuda", icon: "help", placement: "end" },
  ],
} as const satisfies { homeHref: string; moreHref: string; items: readonly WebNavItem[] };

/** Menu visível para o papel. Só esconde: cada página e ação checa a permissão de novo. */
export function navFor(role: MemberRole): NavConfig {
  const items: readonly WebNavItem[] = webNav.items;
  return { ...webNav, items: items.filter((item) => !item.permission || can(role, item.permission)) };
}
