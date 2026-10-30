"use client";

import { CATALOG_LIMITS, type ProductImage } from "@duckzap/contracts/catalog";
import { Button } from "@duckzap/ui/components/button";
import { Progress, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import { useId, useRef, useState } from "react";
import { acceptAttribute, mediaRulesHint } from "@/lib/media";
import type { usePhotoUploads } from "../use-photo-uploads";

type Uploads = ReturnType<typeof usePhotoUploads>;

const tile = "relative flex aspect-square min-w-0 flex-col items-center justify-center overflow-hidden rounded-control border border-line bg-surface-2";

/**
 * Fotos do produto (até 3; a primeira é a capa): as já salvas, as que acabaram de subir e o botão de adicionar.
 * Remover uma foto salva é imediato (chama a API); remover uma nova só descarta o envio.
 */
export function ProductPhotos({
  saved,
  uploads,
  removingId,
  onRemoveSaved,
  disabled,
}: {
  saved: ProductImage[];
  uploads: Uploads;
  removingId: string | null;
  onRemoveSaved: (image: ProductImage) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const used = saved.length + uploads.photos.length;
  const slots = CATALOG_LIMITS.maxImages - used;

  function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    setNotice(uploads.add(Array.from(files), slots));
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-1.5 text-[13px] font-semibold">
        Fotos <span className="font-normal text-ink-2">({used} de {CATALOG_LIMITS.maxImages})</span>
      </legend>
      <ul className="grid grid-cols-3 gap-2.5">
        {saved.map((image, index) => (
          <li key={image.id} className={tile}>
            {image.thumbnailUrl ?? image.url ? (
              // URL assinada de outro domínio: <img> simples (next/image não serve)
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image.thumbnailUrl ?? image.url ?? ""} alt={`Foto ${index + 1} do produto`} className="size-full object-cover" />
            ) : (
              <Icon name="image" size={24} className="text-ink-2" />
            )}
            {index === 0 ? <CoverBadge /> : null}
            <RemoveButton label={`Remover foto ${index + 1}`} busy={removingId === image.id} onClick={() => onRemoveSaved(image)} />
          </li>
        ))}
        {uploads.photos.map((photo, index) => {
          const position = saved.length + index + 1;
          return (
            <li key={photo.key} className={cn(tile, photo.status === "error" && "border-err")}>
              {/* miniatura local (blob:), não passa por next/image */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.preview} alt={`Foto ${position} do produto`} className={cn("size-full object-cover", photo.status !== "ready" && "opacity-50")} />
              {position === 1 ? <CoverBadge /> : null}
              {photo.status === "uploading" ? (
                <div className="absolute inset-x-2 bottom-2" role="status">
                  <Progress value={photo.percent} label={`Enviando foto ${position}`} tone="duck" />
                </div>
              ) : null}
              {photo.status === "error" ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-surface/85 p-1.5 text-center" role="alert">
                  <p className="line-clamp-3 text-[11px] font-semibold leading-tight text-err">{photo.error}</p>
                  <Button size="sm" className="h-7 px-2 text-xs" onClick={() => uploads.retry(photo.key)}>
                    Tentar de novo
                  </Button>
                </div>
              ) : null}
              <RemoveButton label={`Remover foto ${position}`} onClick={() => uploads.drop(photo.key)} />
            </li>
          );
        })}
        {slots > 0 ? (
          <li className="min-w-0">
            <label
              htmlFor={inputId}
              className={cn(
                tile,
                "w-full cursor-pointer gap-1 border-dashed text-[13px] font-semibold text-ink-2 hover:bg-surface-hover has-focus-visible:ring-3 has-focus-visible:ring-ink",
                disabled && "pointer-events-none opacity-60",
              )}
            >
              <Icon name="plus" size={20} />
              Adicionar
              <input id={inputId} ref={inputRef} type="file" accept={acceptAttribute("image")} multiple className="sr-only" onChange={(e) => pick(e.target.files)} />
            </label>
          </li>
        ) : null}
      </ul>
      <p className="mt-1.5 text-xs text-ink-2">{mediaRulesHint("image")}. A primeira foto é a capa e a IA a envia ao cliente.</p>
      {notice ? (
        <p role="alert" className="mt-1.5 text-[13px] font-semibold text-err">
          {notice}
        </p>
      ) : null}
    </fieldset>
  );
}

function CoverBadge() {
  return <span className="absolute left-1.5 top-1.5 rounded-full bg-ink px-2 py-0.5 text-[11px] font-bold text-surface">Capa</span>;
}

function RemoveButton({ label, onClick, busy }: { label: string; onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={busy}
      className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-full border border-line bg-surface text-ink hover:bg-surface-hover disabled:opacity-60"
    >
      {busy ? <Spinner size={14} /> : <Icon name="close" size={14} strokeWidth={2} />}
    </button>
  );
}
