import type { ReactNode } from "react";
import { Icon } from "../components/icon";

export function TopBar({
  actions,
  userMenu,
  searchPlaceholder = "Buscar clientes, conversas, ações…",
}: {
  actions?: ReactNode;
  userMenu: ReactNode;
  searchPlaceholder?: string;
}) {
  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-3.5 border-b border-line bg-surface px-6 max-md:gap-2 max-md:px-3">
      <button
        type="button"
        className="flex h-10 w-[min(420px,100%)] items-center gap-2.5 rounded-control border border-line bg-bg px-3 text-ink-2 max-md:w-10 max-md:justify-center max-md:px-0"
        aria-label={searchPlaceholder.replace("…", "")}
      >
        <Icon name="search" size={18} />
        <span className="max-md:hidden">{searchPlaceholder}</span>
        <kbd className="ml-auto rounded-md border border-field bg-surface px-1.5 py-0.5 text-[11px] font-semibold max-md:hidden">
          Ctrl K
        </kbd>
      </button>
      <div className="flex-1" />
      {actions}
      {userMenu}
    </header>
  );
}
