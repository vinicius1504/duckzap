import { Icon } from "../components/icon";
import { LogoMark } from "../components/logo";
import { cn } from "../lib/cn";
import { isActive, type LinkComponent, type NavConfig, type NavItem } from "./types";

function RailLink({ item, active, Link }: { item: NavItem; active: boolean; Link: LinkComponent }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-[72px] flex-col items-center gap-[3px] rounded-xl py-[9px] text-[11px] font-semibold text-rail-fg hover:bg-rail-hover hover:text-white",
        active && "bg-duck text-on-duck hover:bg-duck hover:text-on-duck",
      )}
    >
      <Icon name={item.icon} size={22} />
      {item.label}
    </Link>
  );
}

export function Rail({
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
  const main = nav.items.filter((item) => item.placement !== "end");
  const end = nav.items.filter((item) => item.placement === "end");

  return (
    <nav
      aria-label={label}
      className="sticky top-0 flex h-dvh w-[88px] shrink-0 flex-col items-center gap-1 overflow-y-auto bg-rail px-2 py-3.5 max-md:hidden"
    >
      <Link href={nav.homeHref} aria-label="Início" className="mb-3.5 mt-0.5 rounded-[10px]">
        <LogoMark size={40} tone="onDark" />
      </Link>
      {main.map((item) => (
        <RailLink key={item.href} item={item} active={isActive(currentPath, item.href)} Link={Link} />
      ))}
      <div className="flex-1" />
      {end.map((item) => (
        <RailLink key={item.href} item={item} active={isActive(currentPath, item.href)} Link={Link} />
      ))}
    </nav>
  );
}
