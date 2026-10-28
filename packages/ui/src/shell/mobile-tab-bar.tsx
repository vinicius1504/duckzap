import { Icon } from "../components/icon";
import { cn } from "../lib/cn";
import { isActive, type LinkComponent, type NavConfig } from "./types";

export function MobileTabBar({
  nav,
  currentPath,
  Link,
  label,
}: {
  nav: NavConfig;
  currentPath: string;
  Link: LinkComponent;
  label: string;
}) {
  const tabs = nav.items.filter((item) => item.mobile === "tab");
  const inTabs = tabs.some((item) => isActive(currentPath, item.href));
  const entries = [...tabs, { href: nav.moreHref, label: "Mais", icon: "more" as const }];

  return (
    <nav
      aria-label={label}
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${entries.length}, minmax(0, 1fr))` }}>
        {entries.map((item) => {
          const active =
            item.href === nav.moreHref ? !inTabs && currentPath !== nav.homeHref : isActive(currentPath, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold text-ink-2",
                  active && "text-ink",
                )}
              >
                <span className={cn("flex h-7 w-12 items-center justify-center rounded-full", active && "bg-duck text-on-duck")}>
                  <Icon name={item.icon} size={20} />
                </span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
