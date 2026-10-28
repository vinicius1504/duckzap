import type { Session } from "@duckzap/contracts/session";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { LogoMark } from "@duckzap/ui/components/logo";
import Link from "next/link";
import { signOutAction } from "@/features/auth/actions";

/**
 * Conta suspensa por falta de pagamento: o sistema fica bloqueado e o WhatsApp é desconectado.
 * Só o Proprietário acessa Plano e cobrança (billing.manage); os demais são orientados a falar com ele.
 */
export function SuspendedScreen({ session }: { session: Session }) {
  const isOwner = session.user.role === "owner";
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-6 px-4 py-10">
      <div className="flex items-center gap-3">
        <LogoMark size={36} />
        <span className="font-bold">{session.organization.name}</span>
      </div>
      <Card>
        <EmptyState
          icon="alert"
          title="Sua conta está suspensa"
          description={
            isOwner
              ? "O pagamento do plano não foi identificado e o prazo de tolerância acabou. Faça o acerto de contas para voltar a usar o sistema. Seu WhatsApp foi desconectado e será preciso ler o QR Code de novo depois que a conta for regularizada. Suas conversas e contatos continuam guardados."
              : "O pagamento do plano da sua empresa não foi identificado. Peça ao proprietário da conta para fazer o acerto de contas. Enquanto isso o sistema fica bloqueado. As conversas e os contatos continuam guardados."
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {isOwner ? (
                <Link href="/ajustes?aba=plano" className={buttonVariants({ variant: "primary" })}>
                  Ver plano e fazer o acerto
                </Link>
              ) : null}
              <form action={signOutAction}>
                <Button type="submit">Sair</Button>
              </form>
            </div>
          }
        />
      </Card>
    </main>
  );
}
