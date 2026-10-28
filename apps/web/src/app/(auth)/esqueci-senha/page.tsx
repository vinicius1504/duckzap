import type { Metadata } from "next";
import Link from "next/link";
import { AuthSplit } from "@/features/onboarding/components/auth-split";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Esqueci a senha" };

export default function ForgotPasswordPage() {
  return (
    <AuthSplit>
      <ForgotPasswordForm />
      <p className="mt-6 text-center text-ink-2">
        Lembrou?{" "}
        <Link href="/entrar" className="font-bold text-ink underline">
          Voltar para Entrar
        </Link>
      </p>
    </AuthSplit>
  );
}
