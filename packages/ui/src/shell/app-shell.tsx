import type { ReactNode } from "react";
import { MobileTabBar } from "./mobile-tab-bar";
import { Rail } from "./rail";
import { TopBar } from "./top-bar";
import type { LinkComponent, NavConfig } from "./types";

/**
 * Moldura comum a todos os apps (cliente e super admin): rail no desktop,
 * tab bar no celular. Cada app passa o próprio menu, ações do topo e menu do usuário.
 */
export function AppShell({
  nav,
  currentPath,
  Link,
  userMenu,
  topBarActions,
  title,
  banner,
  children,
}: {
  nav: NavConfig;
  currentPath: string;
  Link: LinkComponent;
  userMenu: ReactNode;
  topBarActions?: ReactNode;
  /** Nome mostrado no topo: a empresa (app) ou o painel (admin). */
  title?: string;
  /** Faixa fixa abaixo do topo (ex.: plano expirado). */
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh">
      <Rail nav={nav} currentPath={currentPath} Link={Link} label="Menu principal" />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar userMenu={userMenu} actions={topBarActions} title={title} />
        {banner}
        <div className="flex-1 max-md:pb-20">{children}</div>
      </div>
      <MobileTabBar nav={nav} currentPath={currentPath} Link={Link} label="Navegação" />
    </div>
  );
}
