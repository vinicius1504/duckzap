import { brand } from "@duckzap/brand";
import { Icon } from "@duckzap/ui/components/icon";
import { Logo } from "@duckzap/ui/components/logo";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Moldura das telas públicas (criar conta, esqueci a senha), igual à de /entrar:
 * formulário à esquerda e painel da marca à direita (some abaixo de 800px).
 * Candidata a componente compartilhado (hoje /entrar tem a própria cópia).
 */
export function AuthSplit({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-wrap bg-surface">
      <main className="flex min-w-0 flex-[1_1_480px] flex-col px-14 py-10 max-sm:px-4 max-sm:py-6">
        <Link
          href="/entrar"
          className="self-start rounded-control"
          aria-label={`${brand.name}: ir para Entrar`}
        >
          <Logo />
        </Link>

        <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
          {children}
        </div>

        <p className="text-xs text-ink-2">
          © {brand.name} ·{" "}
          <Link href="/termos" className="underline">
            Termos
          </Link>{" "}
          ·{" "}
          <Link href="/privacidade" className="underline">
            Privacidade
          </Link>
        </p>
      </main>

      <aside className="relative flex min-w-0 flex-[1_1_480px] flex-col justify-center gap-10 overflow-hidden bg-rail p-14 text-white max-[800px]:hidden">
        <svg
          width="560"
          height="560"
          viewBox="0 0 560 560"
          aria-hidden="true"
          className="absolute -bottom-[170px] -right-[150px]"
        >
          <circle cx="300" cy="320" r="230" fill="var(--duck)" />
          <path d="M90 330c-40 0-60 40-60 40l70 10z" fill="var(--duck)" />
          <circle cx="190" cy="250" r="22" fill="var(--rail)" />
          <path d="M40 270l-60 24 60 28z" fill="var(--duck-beak)" transform="translate(70 -10)" />
        </svg>
        <div className="relative max-w-[460px]">
          <h2 className="text-4xl font-extrabold leading-[1.15] tracking-[-0.02em]">
            {brand.tagline}
          </h2>
          <p className="mt-3.5 text-base text-rail-fg">{brand.description}</p>
        </div>
        <div className="relative flex max-w-[420px] flex-col gap-2.5" aria-hidden="true">
          <div className="max-w-[300px] self-start rounded-[16px_16px_16px_4px] bg-rail-hover px-4 py-3">
            Oi! Vocês têm horário para limpeza na sexta?
          </div>
          <div className="max-w-[320px] self-end rounded-[16px_16px_4px_16px] bg-duck px-4 py-3 font-medium text-on-duck">
            Tenho sexta às 14h30 ou às 16h. Qual fica melhor para você?
          </div>
          <span className="flex items-center gap-1.5 self-end text-xs text-rail-fg">
            <Icon name="bot" size={14} strokeWidth={2} /> {brand.agentName} · IA
          </span>
        </div>
      </aside>
    </div>
  );
}
