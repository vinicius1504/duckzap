import type { NavConfig } from "@duckzap/ui/shell";

export const adminNav = {
  homeHref: "/visao-geral",
  moreHref: "/mais",
  items: [
    { href: "/visao-geral", label: "Visão geral", icon: "chart", mobile: "tab" },
    { href: "/empresas", label: "Empresas", icon: "building", mobile: "tab" },
    { href: "/assinaturas", label: "Assinaturas", icon: "card", mobile: "tab" },
    { href: "/planos", label: "Planos", icon: "tag", mobile: "tab" },
    { href: "/auditoria", label: "Auditoria", icon: "history" },
  ],
} as const satisfies NavConfig;
