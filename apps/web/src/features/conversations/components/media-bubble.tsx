"use client";

import type { Message } from "@duckzap/contracts/conversations";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@duckzap/ui/components/dialog";
import { Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { describeAttachment, describeFile, formatDuration } from "@/lib/media";

type Props = {
  /** mensagem de imagem, documento ou áudio */
  message: Message;
  /** balão escuro (mensagem enviada pela equipe) */
  inverted: boolean;
};

/**
 * Mídia dentro do balão. A `url` do contrato é assinada e expira em minutos; se o arquivo não carregar mostramos
 * "Arquivo expirou" com um botão que recarrega a conversa (o servidor devolve URLs novas). Sem cache de URL aqui.
 */
export function MediaBubble({ message, inverted }: Props) {
  const router = useRouter();
  const [reloading, startReload] = useTransition();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const att = message.attachment;
  const url = att?.url ?? null;
  const expired = url !== null && failedUrl === url;
  const sub = inverted ? "text-bg/80" : "text-ink-2";
  const iconBox = inverted ? "bg-bg/15" : "bg-surface-2";
  const fileName = att?.fileName ?? null;
  const caption = message.body.trim();

  const info = att ? describeAttachment(att) : "";
  const kindLabel = message.kind === "image" ? "Imagem" : message.kind === "audio" ? "Áudio" : "Documento";
  const title = fileName ?? kindLabel;

  let media: ReactNode;
  if (!att || url === null) {
    // mensagem recém-enviada ainda sem URL: não é erro, só falta o servidor confirmar
    const pending = message.status === "sending";
    media = (
      <div className="flex w-64 max-w-full items-center gap-3">
        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-control", iconBox)}>
          {pending ? <Spinner size={18} /> : <Icon name="file" size={20} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{pending ? "Enviando arquivo…" : "Arquivo indisponível"}</span>
          <span className={cn("block truncate text-xs", sub)}>{fileName ? `${fileName} · ${info}` : info || kindLabel}</span>
        </span>
      </div>
    );
  } else if (expired) {
    media = (
      <div className="flex w-64 max-w-full flex-col gap-2" role="status">
        <span className="flex items-center gap-2 font-semibold">
          <Icon name="alert" size={18} className="shrink-0" />
          Arquivo expirou — recarregue a conversa
        </span>
        <button
          type="button"
          disabled={reloading}
          onClick={() => startReload(() => router.refresh())}
          className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "self-start max-md:h-11")}
        >
          {reloading ? <Spinner size={14} /> : <Icon name="refresh" size={16} />}
          {reloading ? "Recarregando…" : "Recarregar"}
        </button>
      </div>
    );
  } else if (message.kind === "image") {
    const alt = caption || "Imagem";
    media = (
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label={`Ampliar imagem${fileName ? `: ${fileName}` : ""}`}
            className="block max-w-80 cursor-zoom-in overflow-hidden rounded-control"
          >
            {/* URL assinada de outro domínio: <img> simples (next/image não serve) */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={alt}
              loading="lazy"
              decoding="async"
              onError={() => setFailedUrl(url)}
              className={cn("block h-auto max-h-72 w-auto max-w-full", iconBox)}
            />
          </button>
        </DialogTrigger>
        <DialogContent title={fileName ?? "Imagem"} size="lg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={alt}
            onError={() => setFailedUrl(url)}
            className="mx-auto block h-auto max-h-[70dvh] w-auto max-w-full rounded-control"
          />
          <DialogFooter>
            <DownloadLink url={url} fileName={fileName} label="Baixar imagem" />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  } else if (message.kind === "audio") {
    const seconds = att.durationSeconds;
    media = (
      <div className="flex w-64 max-w-full flex-col gap-1">
        <audio
          controls
          preload="metadata"
          src={url}
          aria-label={seconds ? `Áudio, ${formatDuration(seconds)}` : "Áudio"}
          onError={() => setFailedUrl(url)}
          className="h-10 w-full"
        />
        <span className={cn("text-xs tabular-nums", sub)}>{seconds ? `Áudio · ${formatDuration(seconds)}` : "Áudio"}</span>
      </div>
    );
  } else {
    const { short } = describeFile(att.mimeType, fileName);
    media = (
      <div className="flex w-64 max-w-full flex-col gap-2">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className={cn("flex size-11 shrink-0 items-center justify-center rounded-control text-[11px] font-extrabold", iconBox)}
          >
            {short}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold" title={fileName ?? undefined}>
              {title}
            </span>
            <span className={cn("block text-xs", sub)}>{info}</span>
          </span>
        </div>
        <DownloadLink url={url} fileName={fileName} label={`Baixar ${title}`} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {media}
      {caption ? <p className="whitespace-pre-wrap break-words">{caption}</p> : null}
    </div>
  );
}

/** Sempre baixa em outra aba: PDF e Office nunca abrem dentro do app. */
function DownloadLink({ url, fileName, label }: { url: string; fileName: string | null; label: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      download={fileName ?? undefined}
      aria-label={label}
      className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "max-md:h-11")}
    >
      <Icon name="download" size={16} />
      Baixar
    </a>
  );
}
