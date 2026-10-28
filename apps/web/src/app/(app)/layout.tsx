import { isAccountSuspended } from "@duckzap/contracts/session";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ShellFrame } from "@/components/shell-frame";
import { SuspendedScreen } from "@/components/suspended-screen";
import { requireSession } from "@/features/auth/session";
import { getShellStatus } from "@/features/shell/api";
import { currentPathname, isSettingsPath } from "@/lib/access-gate";
import { RealtimeProvider } from "@/lib/realtime/provider";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const pathname = await currentPathname();
  const suspended = isAccountSuspended(session.organization.subscriptionStatus);
  const onSettings = isSettingsPath(pathname);

  // Conta suspensa: bloqueio total, salvo Ajustes (o dono precisa chegar em Plano e cobrança).
  if (suspended && !onSettings) return <SuspendedScreen session={session} />;
  // 2FA obrigatório pendente (dono/admin): só Ajustes → Minha conta, para ativar.
  if (session.user.twoFactorRequired && !onSettings) redirect("/ajustes?aba=conta");

  // Com o portão fechado a API recusa as rotas de negócio: não busca o status dos canais.
  const gated = suspended || Boolean(session.user.twoFactorRequired);
  const status = gated ? { disconnectedChannels: 0, unreadNotifications: 0 } : await getShellStatus();

  const shell = (
    <ShellFrame session={session} status={status} suspended={suspended}>
      {children}
    </ShellFrame>
  );

  // Tempo real (WebSocket) só com a conta liberada: suspensa ou com 2FA pendente não recebe avisos nem atualiza telas.
  return gated ? shell : <RealtimeProvider>{shell}</RealtimeProvider>;
}
