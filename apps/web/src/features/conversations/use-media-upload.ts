"use client";

import type { SendMessageInput } from "@duckzap/contracts/conversations";
import type { MediaKind, MediaReady } from "@duckzap/contracts/media";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { INITIAL_UPLOAD_STATE, putFailureMessage, uploadReducer } from "@/lib/media";
import { completeMediaUploadAction, initMediaUploadAction } from "./actions";
import { putFile } from "./put-file";

export type MessageDraft = Omit<SendMessageInput, "conversationId" | "clientId">;

/** Extra do envio: URL local só para a mensagem otimista mostrar a mídia enquanto o servidor confirma. */
export type SendOptions = { previewUrl?: string | null };

/** Arquivo escolhido (ou áudio gravado) já validado. */
export type PickedMedia = {
  kind: MediaKind;
  file: Blob;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
};

/** Depois disso a mensagem real já substituiu a otimista; solta a URL local. */
const REVOKE_AFTER_MS = 60_000;

/**
 * Envio de mídia em 4 passos: pede upload → PUT no armazenamento (com progresso) → API confere o arquivo → manda a mensagem
 * (`onSend` do compositor, que cuida da mensagem otimista). Um arquivo por vez. Erro em qualquer etapa mantém o arquivo
 * escolhido; "tentar de novo" recomeça da etapa que falhou (só a mensagem, se o arquivo já foi conferido).
 */
export function useMediaUpload(onSend: (draft: MessageDraft, options?: SendOptions) => Promise<string | null>) {
  const [state, dispatch] = useReducer(uploadReducer, INITIAL_UPLOAD_STATE);
  const [item, setItem] = useState<PickedMedia | null>(null);
  const [justSent, setJustSent] = useState(false);
  const itemRef = useRef<PickedMedia | null>(null);
  const captionRef = useRef("");
  const ready = useRef<MediaReady | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** a cada envio/cancelamento muda: respostas atrasadas de uma tentativa antiga são ignoradas */
  const token = useRef(0);
  const inFlight = useRef(false);
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  useEffect(
    () => () => {
      token.current += 1;
      abort.current?.abort();
    },
    [],
  );

  const execute = useCallback(async (picked: PickedMedia, caption: string) => {
    const mine = ++token.current;
    const alive = () => token.current === mine;
    inFlight.current = true;
    try {
      let media = ready.current;
      if (!media) {
        const init = await initMediaUploadAction({
          kind: picked.kind,
          fileName: picked.fileName,
          mimeType: picked.mimeType,
          sizeBytes: picked.sizeBytes,
          durationSeconds: picked.durationSeconds,
        });
        if (!alive()) return;
        if ("error" in init) return void dispatch({ type: "fail", step: "upload", message: init.error });

        const controller = new AbortController();
        abort.current = controller;
        const put = await putFile(init.upload.uploadUrl, init.upload.headers, picked.file, {
          signal: controller.signal,
          onProgress: (percent) => {
            if (alive()) dispatch({ type: "progress", percent });
          },
        });
        abort.current = null;
        if (!alive() || (!put.ok && put.aborted)) return;
        if (!put.ok) return void dispatch({ type: "fail", step: "upload", message: putFailureMessage(put.status) });
        dispatch({ type: "uploaded" });

        const done = await completeMediaUploadAction(init.upload.mediaId);
        if (!alive()) return;
        if ("error" in done) return void dispatch({ type: "fail", step: "check", message: done.error });
        media = done.media;
        ready.current = media;
        dispatch({ type: "checked" });
      }

      const previewUrl = picked.kind === "document" ? null : URL.createObjectURL(picked.file);
      const problem = await onSendRef.current(
        {
          kind: picked.kind,
          body: caption,
          attachment: {
            fileName: media.fileName,
            mimeType: media.mimeType,
            sizeBytes: media.sizeBytes,
            durationSeconds: media.durationSeconds,
            url: null,
            mediaId: media.mediaId,
          },
        },
        { previewUrl },
      );
      if (previewUrl) setTimeout(() => URL.revokeObjectURL(previewUrl), REVOKE_AFTER_MS);
      if (!alive()) return;
      if (problem) return void dispatch({ type: "fail", step: "send", message: problem });

      dispatch({ type: "sent" });
      ready.current = null;
      itemRef.current = null;
      setItem(null);
      setJustSent(true);
      dispatch({ type: "reset" });
    } catch {
      if (alive()) dispatch({ type: "fail", step: "upload", message: "Não foi possível enviar o arquivo. Tente de novo." });
    } finally {
      // cancelar/recomeçar já cuidou do flag; só a tentativa atual solta
      if (alive()) inFlight.current = false;
    }
  }, []);

  /** Define o arquivo a enviar (substitui o anterior, se não estiver enviando). */
  const pick = useCallback((picked: PickedMedia) => {
    if (inFlight.current) return;
    ready.current = null;
    itemRef.current = picked;
    captionRef.current = "";
    setItem(picked);
    setJustSent(false);
    dispatch({ type: "pick" });
  }, []);

  /** Envia o arquivo escolhido (ou `picked`, para o áudio gravado, que não passa pela pré-visualização). */
  const submit = useCallback(
    (caption: string, picked?: PickedMedia) => {
      if (inFlight.current) return;
      if (picked) pick(picked);
      const current = picked ?? itemRef.current;
      if (!current) return;
      captionRef.current = caption.trim();
      dispatch({ type: "start" });
      void execute(current, captionRef.current);
    },
    [execute, pick],
  );

  const retry = useCallback(
    (caption?: string) => {
      if (inFlight.current) return;
      const current = itemRef.current;
      if (!current) return;
      if (caption !== undefined) captionRef.current = caption.trim();
      dispatch({ type: "retry" });
      void execute(current, captionRef.current);
    },
    [execute],
  );

  /** Descarta o arquivo; se estiver enviando ao armazenamento, interrompe. */
  const cancel = useCallback(() => {
    token.current += 1;
    abort.current?.abort();
    abort.current = null;
    ready.current = null;
    itemRef.current = null;
    inFlight.current = false;
    setItem(null);
    dispatch({ type: "reset" });
  }, []);

  return { state, item, justSent, pick, submit, retry, cancel };
}
