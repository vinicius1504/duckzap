"use client";

import { Button } from "@duckzap/ui/components/button";
import { Progress, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import { useEffect, useId, useRef, useState } from "react";
import {
  canCancelUpload,
  describeAttachment,
  describeFile,
  isUploadBusy,
  uploadProgressValue,
  uploadStatusText,
  type UploadState,
} from "@/lib/media";
import type { PickedMedia } from "../use-media-upload";

type Props = {
  item: PickedMedia;
  state: UploadState;
  onSubmit: (caption: string) => void;
  onRetry: (caption: string) => void;
  onCancel: () => void;
};

/** Cartão acima do campo de texto: arquivo escolhido (miniatura ou ícone), legenda, progresso e erro. */
export function AttachmentPreview({ item, state, onSubmit, onRetry, onCancel }: Props) {
  const [caption, setCaption] = useState("");
  const [thumb, setThumb] = useState<string | null>(null);
  const captionRef = useRef<HTMLTextAreaElement>(null);
  const captionId = useId();
  const busy = isUploadBusy(state);
  const failed = state.phase === "error";
  const isAudio = item.kind === "audio";
  const { short } = describeFile(item.mimeType, item.fileName);

  useEffect(() => {
    if (item.kind !== "image") return;
    const url = URL.createObjectURL(item.file);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [item]);

  // ao escolher o arquivo o foco vai para a legenda (o áudio gravado não tem legenda)
  useEffect(() => {
    captionRef.current?.focus();
  }, []);

  function submit() {
    if (state.phase === "chosen") onSubmit(caption);
  }

  return (
    <div className="mb-2.5 rounded-card border border-line bg-surface-2 p-3" role="group" aria-label="Arquivo para enviar">
      <div className="flex items-start gap-3">
        {thumb ? (
          // miniatura local (blob:), não passa por next/image
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="size-16 shrink-0 rounded-control object-cover" />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-control bg-surface text-[11px] font-extrabold"
          >
            {isAudio ? <Icon name="mic" size={22} /> : item.kind === "image" ? <Icon name="image" size={22} /> : short}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold" title={item.fileName}>
            {isAudio ? "Áudio gravado" : item.fileName}
          </p>
          <p className="text-xs text-ink-2">{describeAttachment(item)}</p>

          {isAudio ? null : (
            <div className="mt-2">
              <label htmlFor={captionId} className="sr-only">
                Legenda (opcional)
              </label>
              <textarea
                ref={captionRef}
                id={captionId}
                rows={1}
                maxLength={4096}
                value={caption}
                disabled={busy}
                placeholder="Legenda (opcional)"
                onChange={(e) => setCaption(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (failed) onRetry(caption);
                    else submit();
                  }
                  if (e.key === "Escape" && canCancelUpload(state)) {
                    e.preventDefault();
                    onCancel();
                  }
                }}
                className="max-h-28 min-h-11 w-full resize-none rounded-control border border-field bg-surface px-3 py-2.5 text-ink [field-sizing:content] placeholder:text-ink-2 disabled:opacity-60"
              />
            </div>
          )}
        </div>
      </div>

      {busy ? (
        <div className="mt-3 flex flex-col gap-1.5">
          <Progress value={uploadProgressValue(state)} label="Progresso do envio" tone="duck" />
        </div>
      ) : null}

      {/* anuncia cada etapa ao leitor de tela; o erro tem o próprio alerta */}
      <p
        role={failed ? "alert" : "status"}
        aria-live={failed ? "assertive" : "polite"}
        className={cn("mt-2 flex items-center gap-2 text-[13px] empty:mt-0 empty:h-0", failed ? "font-semibold text-err" : "text-ink-2")}
      >
        {busy ? <Spinner size={14} /> : null}
        {uploadStatusText(state)}
      </p>

      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {failed ? (
          <>
            <Button variant="ghost" className="max-md:h-11" onClick={onCancel}>
              Descartar
            </Button>
            <Button variant="primary" className="max-md:h-11" onClick={() => onRetry(caption)}>
              <Icon name="refresh" size={16} />
              Tentar de novo
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" className="max-md:h-11" onClick={onCancel} disabled={!canCancelUpload(state)}>
              {busy ? "Cancelar envio" : "Cancelar"}
            </Button>
            {state.phase === "chosen" ? (
              <Button variant="primary" className="max-md:h-11" onClick={submit}>
                <Icon name="send" size={16} strokeWidth={2} />
                Enviar
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
