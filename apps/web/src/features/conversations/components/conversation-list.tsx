"use client";

import type { ConversationList as ConversationListData, InboxLookups } from "@duckzap/contracts/conversations";
import { Avatar } from "@duckzap/ui/components/avatar";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import Link from "next/link";
import { debounce, useQueryStates } from "nuqs";
import { useState } from "react";
import { inboxHref, inboxParsers, inboxUrlKeys, tabFromSlug, type TabSlug } from "../search-params";
import { displayName, listTime, PRIORITY_LABEL, previewText, statusChip } from "./view-model";

const TAB_LABEL: Record<TabSlug, string> = {
  minhas: "Minhas",
  aguardando: "Aguardando",
  ia: "IA",
  resolvidas: "Resolvidas",
};

const EMPTY: Record<TabSlug, { title: string; description: string }> = {
  minhas: { title: "Nada com você agora", description: "As conversas que você assumiu ou que foram transferidas para você aparecem aqui." },
  aguardando: { title: "Ninguém na fila", description: "Quando a IA ou alguém da equipe chamar uma pessoa, a conversa aparece aqui." },
  ia: { title: "A IA não está atendendo ninguém", description: "As conversas que a IA está respondendo agora aparecem aqui. Dá para assumir uma quando quiser." },
  resolvidas: { title: "Nenhuma conversa resolvida", description: "Conversas encerradas ficam guardadas aqui." },
};

type Props = {
  list: ConversationListData;
  lookups: InboxLookups;
  tab: TabSlug;
  selectedId: string | null;
  /** query string atual (sem "?"), para montar os links mantendo os filtros */
  query: string;
  nowIso: string;
  timeZone: string;
  hasFilters: boolean;
  /** abas visíveis */
  tabs: readonly TabSlug[];
};

export function ConversationList({ list, lookups, tab, selectedId, query, nowIso, timeZone, hasFilters, tabs }: Props) {
  return (
    <>
      <nav aria-label="Abas de conversas" className="px-4 pt-3.5 max-md:pt-2.5">
        <ul className="flex gap-0.5 rounded-control bg-surface-2 p-[3px] max-md:gap-2 max-md:overflow-x-auto max-md:bg-transparent max-md:p-0">
          {tabs.map((slug) => {
            const active = slug === tab;
            const count = list.counts[tabFromSlug[slug]];
            return (
              <li key={slug} className="flex-1 max-md:flex-none">
                <Link
                  href={inboxHref(query, { tab: slug, conversation: null })}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-[34px] items-center justify-center gap-1 whitespace-nowrap rounded-lg px-1.5 text-[13px] font-semibold text-ink-2",
                    active && "bg-surface text-ink shadow-[0_1px_2px_rgba(15,31,43,.15)]",
                    "max-md:h-11 max-md:rounded-full max-md:border max-md:border-line max-md:bg-surface max-md:px-4 max-md:text-sm max-md:text-ink",
                    active && "max-md:border-ink max-md:bg-ink max-md:text-bg",
                  )}
                >
                  {TAB_LABEL[slug]}
                  {slug === "aguardando" && count > 0 ? (
                    <Chip tone="warn" className="h-5 px-1.5">
                      {count}
                      <span className="sr-only"> na fila</span>
                    </Chip>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <SearchBox />

      {list.items.length === 0 ? (
        <EmptyState
          icon={hasFilters ? "filter" : "chat"}
          title={hasFilters ? "Nenhuma conversa com esses filtros" : EMPTY[tab].title}
          description={hasFilters ? "Tente outro canal, equipe ou etiqueta, ou limpe a busca." : EMPTY[tab].description}
          action={
            hasFilters ? (
              <Link href={inboxHref("", { tab })} className={buttonVariants({ size: "sm" })}>
                Limpar filtros
              </Link>
            ) : undefined
          }
        />
      ) : (
        <ul aria-label={`Conversas: ${TAB_LABEL[tab]}`} className="relative min-h-0 flex-1 overflow-y-auto">
          {list.items.map((c) => {
            const chip = statusChip(c, lookups);
            const channel = lookups.channels.find((ch) => ch.id === c.channelId);
            const isInstagram = channel?.kind === "instagram";
            const selected = c.id === selectedId;
            const name = displayName(c.contact);
            return (
              <li key={c.id}>
                <Link
                  href={inboxHref(query, { conversation: c.id })}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex w-full gap-3 border-b border-line px-4 py-3.5 text-left hover:bg-surface-hover",
                    selected && "bg-duck/15 hover:bg-duck/20",
                  )}
                >
                  <span className="relative shrink-0">
                    <Avatar name={c.contact.name} />
                    {isInstagram ? (
                      <span
                        aria-hidden="true"
                        className="absolute -bottom-1 -right-1 flex size-[18px] items-center justify-center rounded-full border-2 border-surface bg-ink text-bg"
                      >
                        <Icon name="instagram" size={10} strokeWidth={2.4} />
                      </span>
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex justify-between gap-2">
                      <strong className="truncate">{name}</strong>
                      <span className="shrink-0 text-xs text-ink-2">{listTime(c.lastMessage.at, nowIso, timeZone)}</span>
                    </span>
                    <span className="block truncate text-ink-2">{previewText(c.lastMessage)}</span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Chip tone={chip.tone}>{chip.label}</Chip>
                      {isInstagram ? <Chip tone="info">Instagram</Chip> : null}
                      {c.priority === "urgent" ? <Chip tone={PRIORITY_LABEL.urgent.tone}>Urgente</Chip> : null}
                      {c.unreadCount > 0 ? (
                        <Chip className="bg-duck text-on-duck">
                          {c.unreadCount}
                          <span className="sr-only">{c.unreadCount === 1 ? " mensagem não lida" : " mensagens não lidas"}</span>
                        </Chip>
                      ) : null}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function SearchBox() {
  const [state, setState] = useQueryStates(inboxParsers, { urlKeys: inboxUrlKeys, shallow: false });
  const [value, setValue] = useState(state.q ?? "");

  return (
    <div className="px-4 py-3">
      <label htmlFor="busca-conversa" className="sr-only">
        Buscar conversa
      </label>
      <div className="relative">
        <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2" />
        <input
          id="busca-conversa"
          type="search"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setState({ q: e.target.value.trim() || null }, { limitUrlUpdates: debounce(350) });
          }}
          placeholder="Buscar por nome ou mensagem"
          className="h-10 w-full rounded-control border border-field bg-surface pl-10 pr-3 text-ink placeholder:text-ink-2 max-md:h-11"
        />
      </div>
    </div>
  );
}
