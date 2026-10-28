import { brand } from "@duckzap/brand";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Logo } from "@duckzap/ui/components/logo";
import Link from "next/link";

export type LegalSection = { id: string; title: string; topics?: string[] };

/** Página de texto legal (Termos, Privacidade) com sumário. O conteúdo jurídico está [A DEFINIR]. */
export function LegalPage({
  title,
  intro,
  sections,
  other,
}: {
  title: string;
  intro: string;
  sections: LegalSection[];
  other: { href: string; label: string };
}) {
  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[960px] flex-wrap items-center justify-between gap-3 px-6 py-4 max-sm:px-4">
          <Link
            href="/entrar"
            className="rounded-control"
            aria-label={`${brand.name}: ir para Entrar`}
          >
            <Logo />
          </Link>
          <nav aria-label="Páginas legais" className="flex flex-wrap gap-2">
            <Link href={other.href} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              {other.label}
            </Link>
            <Link href="/entrar" className={buttonVariants({ size: "sm" })}>
              Entrar
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex max-w-[960px] flex-wrap items-start gap-8 px-6 py-10 max-sm:px-4 max-sm:py-6">
        <nav
          aria-label="Nesta página"
          className="top-6 flex-[1_1_200px] md:sticky md:max-w-[240px]"
        >
          <p className="mb-2 text-xs font-bold text-ink-2">Nesta página</p>
          <ol className="flex flex-col gap-1 text-[13px]">
            {sections.map((s, i) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="block rounded-lg px-2 py-1.5 text-ink-2 hover:bg-surface-hover hover:text-ink"
                >
                  {i + 1}. {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <article className="min-w-0 flex-[3_1_480px] rounded-card border border-line bg-surface p-8 leading-relaxed max-sm:p-5">
          <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">{title}</h1>
          <p className="mt-1 text-[13px] text-ink-2">
            Última atualização: [A DEFINIR] · Versão [A DEFINIR]
          </p>
          <p className="mt-5 text-ink-2">{intro}</p>
          <p className="mt-3 rounded-control bg-warn-bg px-3.5 py-2.5 text-warn">
            Texto em elaboração com o jurídico. Os trechos marcados com [A DEFINIR] ainda não valem
            como contrato.
          </p>

          {sections.map((s, i) => (
            <section
              key={s.id}
              id={s.id}
              aria-labelledby={`${s.id}-titulo`}
              className="mt-8 scroll-mt-6"
            >
              <h2 id={`${s.id}-titulo`} className="text-lg font-bold">
                {i + 1}. {s.title}
              </h2>
              <p className="mt-2 text-ink-2">[A DEFINIR]</p>
              {s.topics?.length ? (
                <ul className="mt-2 list-disc pl-5 text-ink-2">
                  {s.topics.map((t) => (
                    <li key={t}>{t}: [A DEFINIR]</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}

          <p className="mt-10 border-t border-line pt-5 text-[13px] text-ink-2">
            Dúvidas: {brand.supportEmail} · © {brand.name}
          </p>
        </article>
      </main>
    </div>
  );
}
