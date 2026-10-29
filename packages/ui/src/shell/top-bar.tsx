import type { ReactNode } from "react";
import { Icon } from "../components/icon";

/** `title`: nome da empresa (app) ou do painel (admin). Sem busca global: o atalho nunca funcionou. */
export function TopBar({ actions, userMenu, title }: { actions?: ReactNode; userMenu: ReactNode; title?: string }) {
  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3.5 border-b border-line bg-surface px-6 max-md:gap-2 max-md:px-3">
      {title ? (
        <p className="flex min-w-0 items-center gap-2.5 font-bold text-ink">
          <Icon name="building" size={18} className="shrink-0 text-ink-2" />
          <span className="truncate">{title}</span>
        </p>
      ) : null}
      <div className="flex-1" />
      {actions}
      {userMenu}
    </header>
  );
}
