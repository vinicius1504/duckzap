import { Button } from "@duckzap/ui/components/button";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { Input } from "@duckzap/ui/components/input";
import { Page } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { requireSession } from "@/features/auth/session";
import { getHelpCenter } from "@/features/help/api";
import { AssistantChat } from "@/features/help/components/assistant-chat";
import { isRealLink } from "@/features/help/components/links";
import { RestartTourButton } from "@/features/help/components/restart-tour-button";
import { SupportForm } from "@/features/help/components/support-form";
import { formatDuration } from "@/lib/format";

export const metadata: Metadata = { title: "Ajuda" };

const querySchema = z.string().trim().max(100).catch("");

export default async function HelpPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireSession();
  const query = querySchema.parse((await searchParams).q ?? "");
  const help = await getHelpCenter(query);

  return (
    <Page className="max-w-275">
      <div className="flex flex-col gap-3.5">
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">Como podemos ajudar?</h1>
        <div className="flex flex-wrap gap-2">
          {/* busca na URL (?q=): funciona sem JavaScript e o link pode ser compartilhado */}
          <form action="/ajuda" role="search" className="flex flex-[1_1_320px] gap-2">
            <label htmlFor="busca-ajuda" className="sr-only">
              Buscar na ajuda
            </label>
            <Input id="busca-ajuda" name="q" defaultValue={query} placeholder="Ex.: como conectar um novo número" type="search" />
            <Button type="submit" variant="primary" size="lg">
              Buscar
            </Button>
          </form>
          <RestartTourButton />
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[2_1_520px] flex-col gap-5">
          <Card className="px-[22px] py-2 max-sm:px-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-1 pt-3.5">
              <CardTitle>{query ? `Resultados para “${query}”` : "Perguntas frequentes"}</CardTitle>
              {query ? (
                <Link href="/ajuda" className="text-[13px] font-semibold underline">
                  Limpar busca
                </Link>
              ) : null}
            </div>
            {help.faq.length ? (
              <div>
                {help.faq.map((item, index) => (
                  <details key={item.id} open={index === 0 && !query ? true : undefined} className="group border-t border-line first:border-t-0">
                    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-3 font-semibold [&::-webkit-details-marker]:hidden">
                      {item.question}
                      <Icon name="chevronDown" size={18} className="shrink-0 text-ink-2 transition-transform group-open:rotate-180" />
                    </summary>
                    <p className="pb-4 text-ink-2">{item.answer}</p>
                  </details>
                ))}
              </div>
            ) : (
              <EmptyState
                icon="search"
                title="Nada encontrado"
                description="Tente outras palavras ou pergunte ao assistente de ajuda."
                action={
                  <Link href="/ajuda" className="font-semibold underline">
                    Ver todas as perguntas
                  </Link>
                }
              />
            )}
          </Card>

          <Card className="p-[22px] max-sm:p-4">
            <CardTitle className="mb-3">Vídeos rápidos</CardTitle>
            <ul className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))]">
              {help.videos.map((video) => (
                <li key={video.id}>
                  <div className="flex aspect-video items-center justify-center rounded-control bg-rail text-duck">
                    <Icon name="play" size={32} />
                  </div>
                  <p className="mt-1.5 font-semibold">{video.title}</p>
                  <p className="text-xs text-ink-2">
                    {formatDuration(video.durationSeconds)}
                    {video.url ? "" : " · em breve"}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
          <AssistantChat />
          <SupportForm hours={help.support.hours} whatsappUrl={help.support.whatsappUrl} />
          <p className="text-[13px] text-ink-2">
            <FooterLink url={help.support.termsUrl}>Termos de uso</FooterLink> ·{" "}
            <FooterLink url={help.support.privacyUrl}>Política de privacidade</FooterLink>
          </p>
        </aside>
      </div>
    </Page>
  );
}

function FooterLink({ url, children }: { url: string; children: string }) {
  if (!isRealLink(url)) return <span>{children}</span>;
  return (
    <a href={url} className="underline" target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
