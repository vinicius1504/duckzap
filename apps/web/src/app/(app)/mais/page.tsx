import { Card } from "@duckzap/ui/components/card";
import { Icon } from "@duckzap/ui/components/icon";
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
    <main className="px-8 pb-10 pt-7 max-md:px-4">
      <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">Mais</h1>
      <Card className="mt-6 overflow-hidden">
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
    </main>
  );
}
