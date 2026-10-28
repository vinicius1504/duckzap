"use client";

import type { Message, MessageStatus } from "@duckzap/contracts/conversations";
import { Chip } from "@duckzap/ui/components/chip";
import { Icon, type IconName } from "@duckzap/ui/components/icon";
import { Spinner } from "@duckzap/ui/components/feedback";
import { cn } from "@duckzap/ui/cn";
import { Fragment, useEffect, useRef, useState } from "react";
import { MediaBubble } from "./media-bubble";
import { dayLabel, firstName, MESSAGE_STATUS_LABEL, sameDay, timeOf } from "./view-model";

type Props = {
  messages: Message[];
  nowIso: string;
  timeZone: string;
  onResend: (message: Message) => void;
  resendDisabledReason: string | null;
};

/** Perto o bastante do fim para contar como "no fim" (px). */
const AT_BOTTOM_PX = 80;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function MessageThread({ messages, nowIso, timeZone, onResend, resendDisabledReason }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const lastId = messages[messages.length - 1]?.id;
  const atBottom = useRef(true);
  const previousCount = useRef<number | null>(null);
  const [unseen, setUnseen] = useState(0);

  function scrollToBottom(smooth = false) {
    const el = scroller.current;
    if (!el) return;
    if (smooth && !prefersReducedMotion()) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
    atBottom.current = true;
  }

  // Mensagem nova: acompanha só quem já estava no fim (ou quem acabou de enviar). Quem rolou para ler o histórico
  // não é arrastado: aparece o aviso "Nova mensagem".
  useEffect(() => {
    const before = previousCount.current;
    previousCount.current = messages.length;
    const last = messages[messages.length - 1];
    const sentByMe = last?.id.startsWith("tmp_") ?? false; // mensagem otimista do próprio atendente
    if (before === null || atBottom.current || sentByMe) {
      scrollToBottom();
      setUnseen(0);
      return;
    }
    const added = messages.length - before;
    if (added > 0) setUnseen((n) => n + added);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só reage a mudança na lista
  }, [lastId, messages.length]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const reached = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX;
    atBottom.current = reached;
    if (reached) setUnseen(0);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        // imagem que termina de carregar aumenta a conversa: quem estava no fim continua no fim
        onLoadCapture={() => {
          if (atBottom.current) scrollToBottom();
        }}
        role="log"
        aria-label="Mensagens da conversa"
        aria-live="polite"
        // `relative`: os textos `sr-only` (position absolute, ex.: "Lida") ficam presos aqui; sem isso escapam do recorte
        // da rolagem e esticam a página inteira, uma vez por mensagem.
        className="relative flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto bg-bg p-5 max-md:px-3"
      >
        {messages.length === 0 ? <p className="m-auto text-ink-2">Nenhuma mensagem ainda.</p> : null}
        {messages.map((m, index) => {
          const prev = messages[index - 1];
          const newDay = !prev || !sameDay(prev.createdAt, m.createdAt, timeZone);
          return (
            <Fragment key={m.id}>
              {newDay ? (
                <Chip className="self-center" role="separator">
                  {dayLabel(m.createdAt, nowIso, timeZone)}
                </Chip>
              ) : null}
              <MessageItem message={m} timeZone={timeZone} onResend={onResend} resendDisabledReason={resendDisabledReason} />
            </Fragment>
          );
        })}
      </div>
      {unseen > 0 ? (
        <button
          type="button"
          onClick={() => {
            scrollToBottom(true);
            setUnseen(0);
          }}
          className="absolute bottom-3 left-1/2 flex h-11 -translate-x-1/2 items-center gap-1.5 rounded-full bg-duck px-4 text-sm font-bold text-on-duck shadow-lg motion-safe:transition-transform motion-safe:hover:-translate-y-0.5"
        >
          <Icon name="chevronDown" size={16} strokeWidth={2.4} />
          {unseen === 1 ? "Nova mensagem" : `${unseen} novas mensagens`}
        </button>
      ) : null}
    </div>
  );
}

function MessageItem({
  message: m,
  timeZone,
  onResend,
  resendDisabledReason,
}: {
  message: Message;
  timeZone: string;
  onResend: (message: Message) => void;
  resendDisabledReason: string | null;
}) {
  const time = timeOf(m.createdAt, timeZone);

  if (m.kind === "event") {
    return (
      <p className="max-w-[90%] self-center rounded-control bg-info-bg px-3.5 py-2 text-center text-[13px] font-semibold text-info">
        {m.body} <span className="font-normal">· {time}</span>
      </p>
    );
  }

  if (m.kind === "note") {
    return (
      <div className="max-w-[70%] self-end rounded-xl border border-dashed border-warn bg-warn-bg px-3.5 py-2.5 text-ink max-md:max-w-[88%]">
        <span className="text-[11px] font-extrabold uppercase tracking-[.04em] text-warn">Nota interna · só a equipe vê</span>
        <p className="mt-0.5 whitespace-pre-wrap">
          <strong>{firstName(m.author.name)}:</strong> {m.body}
        </p>
        <span className="block text-right text-[11px] text-ink-2">{time}</span>
      </div>
    );
  }

  const incoming = m.direction === "in";
  const failed = m.status === "failed";
  const isAi = m.author.kind === "agent";

  return (
    <div
      className={cn(
        "max-w-[70%] px-3.5 py-2.5 max-md:max-w-[88%]",
        incoming
          ? "self-start rounded-[14px_14px_14px_4px] border border-line bg-surface"
          : failed
            ? "self-end rounded-[14px_14px_4px_14px] border border-err bg-surface"
            : "self-end rounded-[14px_14px_4px_14px] bg-ink text-bg",
      )}
    >
      <Content message={m} inverted={!incoming && !failed} />
      <span
        className={cn(
          "mt-0.5 flex items-center justify-end gap-1.5 text-[11px]",
          incoming || failed ? "text-ink-2" : "text-bg/80",
        )}
      >
        {!incoming ? (
          <span>
            {isAi ? `${m.author.name} · IA` : firstName(m.author.name)} ·{" "}
          </span>
        ) : null}
        <time dateTime={m.createdAt}>{time}</time>
        {!incoming && m.status && m.status !== "failed" ? <StatusIcon status={m.status} /> : null}
      </span>
      {failed ? (
        <span className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg bg-err-bg px-2 py-1 text-xs font-semibold text-err">
          <span>Não enviada.{m.failureReason ? ` ${m.failureReason}` : ""}</span>
          <button
            type="button"
            onClick={() => onResend(m)}
            disabled={resendDisabledReason !== null}
            title={resendDisabledReason ?? undefined}
            className="min-h-6 font-extrabold underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            Tentar de novo
          </button>
        </span>
      ) : null}
    </div>
  );
}

const statusIcon: Record<Exclude<MessageStatus, "failed">, IconName | null> = {
  sending: null,
  sent: "check",
  delivered: "checkDouble",
  read: "checkDouble",
};

function StatusIcon({ status }: { status: Exclude<MessageStatus, "failed"> }) {
  const icon = statusIcon[status];
  return (
    <span className={cn("inline-flex", status === "read" && "text-duck")} title={MESSAGE_STATUS_LABEL[status]}>
      {icon ? <Icon name={icon} size={14} strokeWidth={2.4} /> : <Spinner size={12} />}
      <span className="sr-only">{MESSAGE_STATUS_LABEL[status]}</span>
    </span>
  );
}

function Content({ message: m, inverted }: { message: Message; inverted: boolean }) {
  if (m.kind === "audio" || m.kind === "image" || m.kind === "document") return <MediaBubble message={m} inverted={inverted} />;
  return <p className="whitespace-pre-wrap break-words">{m.body}</p>;
}
