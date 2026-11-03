import { Card } from "@duckzap/ui/components/card";
import { Icon } from "@duckzap/ui/components/icon";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import Link from "next/link";
import { navFor } from "@/config/nav";
import { requireSession } from "@/features/auth/session";

export const metadata: Metadata = { title: "Mais" };

// no celular, lista o que não coube na tab bar
export default async function MorePage() {
  const session = await requireSession();
  const items = navFor(session.user.role).items.filter((item) => item.mobile !== "tab");

  return (
    <Page>
      <PageHeader title="Mais" />
      <Card className="overflow-hidden">
        <ul>
          {items.map((item, index) => (
            <li key={item.href} className={index > 0 ? "border-t border-line" : undefined}>
              <Link href={item.href} className="flex min-h-14 items-center gap-3.5 px-4 font-semibold hover:bg-surface-hover">
                <Icon name={item.icon} />
                <span className="flex-1">{item.label}</span>
                <Icon name="chevronRight" size={18} className="text-ink-2" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </Page>
  );
}
