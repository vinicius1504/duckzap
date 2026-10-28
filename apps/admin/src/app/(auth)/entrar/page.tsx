import { Chip } from "@duckzap/ui/components/chip";
import { Icon } from "@duckzap/ui/components/icon";
import { Logo } from "@duckzap/ui/components/logo";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getAdminSession, getPendingChallenge } from "@/features/auth/session";
import { AdminSignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Entrar" };

export default async function AdminSignInPage() {
  if (await getAdminSession()) redirect("/visao-geral");
  const pending = await getPendingChallenge();

  return (
    <main className="flex min-h-dvh flex-col bg-bg px-4 py-8">
      <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Logo />
          <Chip tone="info">
            <Icon name="shield" size={14} strokeWidth={2} />
            Super admin
          </Chip>
        </div>
        <div className="rounded-card border border-line bg-surface p-7 max-sm:p-5">
          <Suspense>
            <AdminSignInForm pendingEmail={pending?.email ?? null} pendingEnrollment={pending?.enrollment ?? null} />
          </Suspense>
        </div>
        <p className="text-center text-xs text-ink-2">
          Acesso restrito à equipe interna. Toda ação no painel fica registrada na auditoria.
        </p>
      </div>
    </main>
  );
}
