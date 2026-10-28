import type { ComponentType, ReactNode } from "react";
import type { IconName } from "../components/icon";

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** "tab": aparece na tab bar do celular; os demais ficam em "Mais". */
  mobile?: "tab";
  /** "end": fica no pé do rail (ex.: Ajuda). */
  placement?: "end";
};

export type NavConfig = {
  /** Destino do logo no topo do rail. */
  homeHref: string;
  items: readonly NavItem[];
  /** Página do celular que lista os itens que não estão na tab bar. */
  moreHref: string;
};

/** O shell não conhece o framework: o app injeta o componente de link (ex.: next/link). */
export type LinkComponent = ComponentType<{
  href: string;
  className?: string;
  children?: ReactNode;
  "aria-current"?: "page";
  "aria-label"?: string;
}>;

export function isActive(currentPath: string, href: string) {
  return currentPath === href || currentPath.startsWith(`${href}/`);
}
