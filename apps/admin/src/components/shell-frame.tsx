"use client";

import type { AdminSession } from "@duckzap/contracts/admin";
import { initialsOf } from "@duckzap/ui/components/avatar";
import { Chip } from "@duckzap/ui/components/chip";
import { Icon } from "@duckzap/ui/components/icon";
import { AppShell, UserMenu } from "@duckzap/ui/shell";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition, type ReactNode } from "react";
import { adminNav } from "@/config/nav";
import { signOutAction } from "@/features/auth/actions";
import { ToastProvider } from "./toast";

export function AdminShellFrame({
  session,
  children,
}: {
  session: AdminSession;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const user = {
    name: session.admin.name,
    email: session.admin.email,
    initials: initialsOf(session.admin.name),
  };

  return (
    <ToastProvider>
      <AppShell
        nav={adminNav}
        currentPath={pathname}
        Link={Link}
        searchPlaceholder="Buscar empresas, planos, ações…"
        topBarActions={
          <Chip tone="info" className="gap-1.5">
            <Icon name="shield" size={14} strokeWidth={2} />
            Super admin
          </Chip>
        }
        userMenu={<UserMenu user={user} onSignOut={() => startTransition(() => signOutAction())} />}
      >
        {children}
      </AppShell>
    </ToastProvider>
  );
}
