"use client";

import type { Notification } from "@duckzap/contracts/notifications";
import { cn } from "@duckzap/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@duckzap/ui/components/dropdown-menu";
import { Skeleton } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import Link from "next/link";
import { useState } from "react";
import { bellLabel, formatBadge, notificationIcon, relativeTime, unreadAnnouncement } from "@/lib/notifications";
import { safeNext } from "@/lib/safe-next";
import { useNotifications } from "../use-notifications";

const KIND_TONE: Record<Notification["kind"], string> = {
  appointment_booked: "bg-ok-bg text-ok",
  appointment_rescheduled: "bg-info-bg text-info",
  appointment_canceled: "bg-err-bg text-err",
};

/** Sino do topo: contador de não lidas e a lista das notificações da pessoa. */
export function NotificationBell({ initialUnread, timeZone }: { initialUnread: number; timeZone: string }) {
  const { list, unread, phase, now, refresh, retry, mark } = useNotifications(initialUnread);
  const [open, setOpen] = useState(false);
  const badge = formatBadge(unread);

  return (
    // `relative` também contém o aviso sr-only (absoluto) para ele não esticar a página
    <div className="relative">
      <DropdownMenu
        modal={false}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) refresh();
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={bellLabel(unread)}
            className="relative flex size-10 items-center justify-center rounded-control border border-line bg-surface hover:bg-surface-hover data-[state=open]:bg-surface-hover max-sm:size-11"
          >
            <Icon name="bell" />
            {badge ? (
              <span
                aria-hidden="true"
                className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-duck px-1 text-[11px] font-extrabold text-on-duck"
              >
                {badge}
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          collisionPadding={8}
          className="flex w-96 max-w-[calc(100vw-1rem)] max-h-(--radix-dropdown-menu-content-available-height) flex-col overflow-hidden p-0"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line py-1 pl-4 pr-1">
            <DropdownMenuLabel className="p-0 text-sm text-ink">Notificações</DropdownMenuLabel>
            <DropdownMenuItem
              disabled={unread === 0}
              onSelect={(event) => {
                // mantém o menu aberto: a pessoa vê a lista ficar toda lida
                event.preventDefault();
                void mark({ all: true });
              }}
              className="min-h-11 text-[13px] font-semibold text-ink-2 sm:min-h-9"
            >
              Marcar todas como lidas
            </DropdownMenuItem>
          </div>

          {/* contêiner rolável com `relative`: elementos sr-only absolutos de dentro não esticam a página */}
          <DropdownMenuGroup aria-label="Lista de notificações" className="relative max-h-96 min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
            {list ? (
              list.items.length === 0 ? (
                <Empty />
              ) : (
                list.items.map((n) => (
                  <NotificationRow
                    key={n.id}
                    n={n}
                    when={relativeTime(n.createdAt, new Date(now), timeZone)}
                    onPick={() => {
                      if (!n.read) void mark({ ids: [n.id] });
                    }}
                  />
                ))
              )
            ) : phase === "error" ? (
              <Failed onRetry={retry} />
            ) : (
              <Loading />
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* anuncia mudanças do contador sem roubar o foco */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {unreadAnnouncement(unread)}
      </span>
    </div>
  );
}

function NotificationRow({ n, when, onPick }: { n: Notification; when: string; onPick: () => void }) {
  // só rota interna (o link vem do servidor, mas não custa nada garantir)
  const href = n.link ? safeNext(n.link, "") : "";
  const content = (
    <>
      <span aria-hidden="true" className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full", KIND_TONE[n.kind])}>
        <Icon name={notificationIcon(n.kind)} size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
        {n.read ? null : <span className="sr-only">Não lida. </span>}
        <span className={cn("font-bold", n.read && "text-ink-2")}>{n.title}</span>
        <span className="break-words text-[13px] text-ink-2">{n.body}</span>
        <span className="text-xs text-ink-2">{when}</span>
      </span>
      {n.read ? null : <span aria-hidden="true" className="mt-2 size-2.5 shrink-0 rounded-full bg-duck" />}
    </>
  );
  const className = cn("relative min-h-14 items-start gap-3 py-2 sm:min-h-12", n.read ? "opacity-75" : "bg-surface-2");

  return href ? (
    <DropdownMenuItem asChild onSelect={onPick} className={className}>
      <Link href={href}>{content}</Link>
    </DropdownMenuItem>
  ) : (
    <DropdownMenuItem onSelect={onPick} className={className}>
      {content}
    </DropdownMenuItem>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-ink-2">
      <span className="flex size-11 items-center justify-center rounded-full bg-surface-2">
        <Icon name="bell" size={22} />
      </span>
      <p className="font-semibold">Nenhuma notificação por enquanto</p>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-3 p-2">
      <span className="sr-only">Carregando notificações…</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3.5 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-6 text-center">
      <p className="font-semibold text-err">Não conseguimos carregar as notificações.</p>
      {/* item de menu (e não botão solto): o Tab não sai do menu, as setas chegam aqui */}
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault();
          onRetry();
        }}
        className="min-h-11 justify-center font-semibold"
      >
        <Icon name="refresh" size={16} />
        Tentar de novo
      </DropdownMenuItem>
    </div>
  );
}
