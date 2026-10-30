"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { putFile } from "@/features/conversations/put-file";
import { putFailureMessage, validateMediaFile } from "@/lib/media";
import { completePhotoUploadAction, initPhotoUploadAction } from "./actions";

export type PhotoStatus = "uploading" | "ready" | "error";

/** Foto escolhida no formulário e ainda não ligada ao produto. */
export type PendingPhoto = {
  key: string;
  fileName: string;
  /** URL local (blob:) só para mostrar a miniatura. */
  preview: string;
  status: PhotoStatus;
  percent: number;
  /** Preenchido quando o servidor conferiu o arquivo: é o que vai para `attachImageAction`. */
  mediaId: string | null;
  error: string | null;
};

type Entry = PendingPhoto & { file: File; mimeType: string };

let counter = 0;

/**
 * Envio das fotos do produto, várias ao mesmo tempo, no mesmo fluxo de mídia das conversas: pede a URL (init), envia direto
 * ao armazenamento com progresso (PUT) e a API confere o arquivo (complete). O resultado é um `mediaId` por foto;
 * ligar ao produto é com quem salva. Sair do formulário solta as URLs locais e interrompe o que estava subindo.
 */
export function usePhotoUploads() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const aborts = useRef(new Map<string, AbortController>());
  /** a cada remoção/recomeço o token muda: respostas atrasadas de uma tentativa antiga são ignoradas */
  const tokens = useRef(new Map<string, number>());
  const previews = useRef(new Set<string>());

  const patch = useCallback((key: string, change: Partial<PendingPhoto>) => {
    setEntries((list) => list.map((e) => (e.key === key ? { ...e, ...change } : e)));
  }, []);

  const run = useCallback(
    async (entry: Entry) => {
      const mine = (tokens.current.get(entry.key) ?? 0) + 1;
      tokens.current.set(entry.key, mine);
      const alive = () => tokens.current.get(entry.key) === mine;
      patch(entry.key, { status: "uploading", percent: 0, error: null });
      try {
        const init = await initPhotoUploadAction({
          kind: "image",
          fileName: entry.fileName,
          mimeType: entry.mimeType,
          sizeBytes: entry.file.size,
          durationSeconds: null,
        });
        if (!alive()) return;
        if ("error" in init) return void patch(entry.key, { status: "error", error: init.error });

        const controller = new AbortController();
        aborts.current.set(entry.key, controller);
        const put = await putFile(init.upload.uploadUrl, init.upload.headers, entry.file, {
          signal: controller.signal,
          onProgress: (percent) => {
            if (alive()) patch(entry.key, { percent });
          },
        });
        aborts.current.delete(entry.key);
        if (!alive() || (!put.ok && put.aborted)) return;
        if (!put.ok) return void patch(entry.key, { status: "error", error: putFailureMessage(put.status) });

        const done = await completePhotoUploadAction(init.upload.mediaId);
        if (!alive()) return;
        if ("error" in done) return void patch(entry.key, { status: "error", error: done.error });
        patch(entry.key, { status: "ready", percent: 100, mediaId: done.media.mediaId });
      } catch {
        if (alive()) patch(entry.key, { status: "error", error: "Não foi possível enviar a foto. Tente de novo." });
      }
    },
    [patch],
  );

  /** Aceita até `slots` fotos; devolve o aviso quando algum arquivo foi recusado ou não coube. */
  const add = useCallback(
    (files: File[], slots: number): string | null => {
      let notice: string | null = null;
      const accepted: Entry[] = [];
      for (const file of files) {
        if (accepted.length >= slots) {
          notice = `O produto aceita até 3 fotos. As que passaram do limite foram ignoradas.`;
          break;
        }
        const check = validateMediaFile("image", { name: file.name, type: file.type, size: file.size });
        if (!check.ok) {
          notice = check.message;
          continue;
        }
        const preview = URL.createObjectURL(file);
        previews.current.add(preview);
        accepted.push({
          key: `foto-${++counter}`,
          fileName: file.name,
          preview,
          status: "uploading",
          percent: 0,
          mediaId: null,
          error: null,
          file,
          mimeType: check.mimeType,
        });
      }
      if (accepted.length === 0) return notice;
      setEntries((list) => [...list, ...accepted]);
      for (const entry of accepted) void run(entry);
      return notice;
    },
    [run],
  );

  const drop = useCallback((key: string) => {
    tokens.current.set(key, (tokens.current.get(key) ?? 0) + 1);
    aborts.current.get(key)?.abort();
    aborts.current.delete(key);
    setEntries((list) => {
      const gone = list.find((e) => e.key === key);
      if (gone) {
        URL.revokeObjectURL(gone.preview);
        previews.current.delete(gone.preview);
      }
      return list.filter((e) => e.key !== key);
    });
  }, []);

  const retry = useCallback(
    (key: string) => {
      const entry = entries.find((e) => e.key === key);
      if (entry && entry.status === "error") void run(entry);
    },
    [entries, run],
  );

  /** Descarta tudo (fechar ou reabrir o formulário). */
  const reset = useCallback(() => {
    for (const [key, controller] of aborts.current) {
      tokens.current.set(key, (tokens.current.get(key) ?? 0) + 1);
      controller.abort();
    }
    aborts.current.clear();
    for (const url of previews.current) URL.revokeObjectURL(url);
    previews.current.clear();
    for (const key of tokens.current.keys()) tokens.current.set(key, (tokens.current.get(key) ?? 0) + 1);
    setEntries([]);
  }, []);

  useEffect(() => reset, [reset]);

  const photos: PendingPhoto[] = entries.map(({ file: _file, mimeType: _mime, ...photo }) => photo);
  return {
    photos,
    busy: entries.some((e) => e.status === "uploading"),
    failed: entries.some((e) => e.status === "error"),
    add,
    drop,
    retry,
    reset,
  };
}
