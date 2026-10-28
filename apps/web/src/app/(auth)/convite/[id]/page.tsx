import { roleLabels } from "@duckzap/contracts/permissions";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Alert, EmptyState } from "@duckzap/ui/components/feedback";
import type { Metadata } from "next";
import Link from "next/link";
import { getSession } from "@/features/auth/session";
import { getInvite } from "@/features/invites/api";
import { AcceptInviteForm } from "@/features/invites/components/accept-invite-form";
import { AuthSplit } from "@/features/onboarding/components/auth-split";

export const metadata: Metadata = { title: "Convite", robots: { index: false, follow: false } };

export default async function InvitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invite = await getInvite(id);

  if (!invite.ok) {
    return (
      <AuthSplit>
        <EmptyState
          icon="alert"
          title={invite.error === "not_found" ? "Convite indisponível" : "Não foi possível abrir o convite"}
          description={invite.message}
          action={
            <Link href="/entrar" className={buttonVariants({ variant: "primary" })}>
              Ir para Entrar
            </Link>
          }
        />
      </AuthSplit>
    );
  }

  const info = invite.data;
  const session = await getSession();
  const sameAccount = session?.user.email.toLowerCase() === info.email.toLowerCase();
  const next = encodeURIComponent(`/convite/${id}`);

  return (
    <AuthSplit>
      <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">Você foi convidado</h1>
      <p className="mb-2 mt-1.5 text-ink-2">
        <strong className="text-ink">{info.organizationName}</strong> convidou {info.name} para entrar como{" "}
        <strong className="text-ink">{roleLabels[info.role]}</strong>.
      </p>
      <p className="mb-6 text-[13px] text-ink-2">
        Convite para <strong className="break-all text-ink">{info.email}</strong>
      </p>

      {session && !sameAccount ? (
        <div className="flex flex-col gap-4">
          <Alert tone="warn" live>
            Você está logado como {session.user.email}, mas este convite é para {info.email}. Saia e entre com o e-mail do convite.
          </Alert>
          <Link href="/inicio" className={buttonVariants({ variant: "secondary", size: "lg" })}>
            Voltar ao início
          </Link>
        </div>
      ) : session ? (
        <AcceptInviteForm token={id} needsPassword={false} />
      ) : info.hasAccount ? (
        <div className="flex flex-col gap-4">
          <p className="text-ink-2">Este e-mail já tem conta. Entre para aceitar o convite.</p>
          <Link href={`/entrar?next=${next}`} className={buttonVariants({ variant: "primary", size: "lg" })}>
            Entrar para aceitar
          </Link>
        </div>
      ) : (
        <AcceptInviteForm token={id} needsPassword />
      )}
    </AuthSplit>
  );
}
