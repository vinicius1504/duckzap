import { Icon } from "@duckzap/ui/components/icon";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import Link from "next/link";
import { adminNav } from "@/config/nav";

export const metadata: Metadata = { title: "Mais" };

// celular: itens do menu que não cabem na tab bar
export default function MorePage() {
  const items = adminNav.items.filter((item) => !("mobile" in item));
  return (
    <Page>
      <PageHeader title="Mais" />
      <ul className="overflow-hidden rounded-card border border-line bg-surface">
        {items.map((item) => (
          <li key={item.href} className="border-b border-line last:border-b-0">
            <Link
              href={item.href}
              className="flex min-h-14 items-center gap-3 px-4 font-semibold hover:bg-surface-hover"
            >
              <Icon name={item.icon} />
              <span className="flex-1">{item.label}</span>
              <Icon name="chevronRight" size={18} className="text-ink-2" />
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
