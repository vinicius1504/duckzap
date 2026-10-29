"use client";

import type { Session } from "@duckzap/contracts/session";
import { initialsOf } from "@duckzap/ui/components/avatar";
import { Chip } from "@duckzap/ui/components/chip";
import { DropdownMenuItem } from "@duckzap/ui/components/dropdown-menu";
import { Alert } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { AppShell, UserMenu } from "@duckzap/ui/shell";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition, type ReactNode } from "react";
import { navFor } from "@/config/nav";
import { signOutAction } from "@/features/auth/actions";
import { NotificationBell } from "@/features/notifications/components/notification-bell";
import type { ShellStatus } from "@/features/shell/api";
import { RealtimeStatusChip, SoundToggle } from "@/lib/realtime/controls";

export function ShellFrame({
  session,
  status,
  suspended,
  children,
}: {
  session: Session;
  status: ShellStatus;
  /** Conta suspensa: só Ajustes abre (Plano e cobrança / Minha conta). */
  suspended: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const user = { name: session.user.name, email: session.user.email, initials: initialsOf(session.user.name) };

  const actions = (
    <>
      <RealtimeStatusChip />
      {status.disconnectedChannels > 0 ? (
        <Link href="/canais" className="max-sm:hidden">
          <Chip tone="warn">
            <span className="size-2 rounded-full bg-current" aria-hidden="true" />
            {status.disconnectedChannels === 1 ? "1 canal desconectado" : `${status.disconnectedChannels} canais desconectados`}
          </Chip>
        </Link>
      ) : (
        <Link href="/canais" className="max-sm:hidden">
          <Chip tone="ok">
            <span className="size-2 rounded-full bg-current" aria-hidden="true" />
            WhatsApp conectado
          </Chip>
        </Link>
      )}
      <SoundToggle className="max-sm:hidden" />
      <NotificationBell initialUnread={status.unreadNotifications} timeZone={session.organization.timeZone} />
    </>
  );

  return (
    <AppShell
      nav={navFor(session.user.role)}
      currentPath={pathname}
      Link={Link}
      topBarActions={actions}
      title={session.organization.name}
      banner={
        <>
          {suspended ? (
            <Alert tone="err" title="Conta suspensa." className="rounded-none px-6 max-md:px-4">
              Faça o acerto de contas em Plano e cobrança para voltar a usar o sistema.
            </Alert>
          ) : null}
          {!suspended && session.organization.subscriptionStatus === "past_due" ? (
            <Alert tone="warn" title="Sua assinatura venceu." className="rounded-none px-6 max-md:px-4">
              Regularize o pagamento até amanhã. Depois disso o sistema é bloqueado e o WhatsApp é desconectado.
            </Alert>
          ) : null}
          {session.user.twoFactorRequired ? (
            <Alert tone="warn" title="Ative a verificação em duas etapas." className="rounded-none px-6 max-md:px-4">
              Para proprietários e administradores ela é obrigatória. Ative em Minha conta para liberar o resto do sistema.
            </Alert>
          ) : null}
        </>
      }
      userMenu={
        <UserMenu user={user} onSignOut={() => startTransition(() => signOutAction())}>
          <DropdownMenuItem onSelect={() => router.push("/ajustes?aba=conta")}>
            <Icon name="user" size={18} />
            Minha conta
          </DropdownMenuItem>
        </UserMenu>
      }
    >
      {children}
    </AppShell>
  );
}
