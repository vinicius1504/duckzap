"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { micErrorMessage, normalizeMime, pickRecorderMime } from "@/lib/media";

export type Recording = { blob: Blob; mimeType: string; seconds: number };

/**
 * Gravação de voz com MediaRecorder. `seconds` é null quando não está gravando.
 * `start()` devolve a mensagem de erro (permissão, sem microfone, navegador sem suporte) ou null se começou.
 */
export function useVoiceRecorder() {
  const [seconds, setSeconds] = useState<number | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const starting = useRef(false);

  const releaseMic = useCallback(() => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    recorder.current = null;
  }, []);

  useEffect(() => {
    if (seconds === null) return;
    const timer = setInterval(() => setSeconds(Math.max(0, Math.round((Date.now() - startedAt.current) / 1000))), 500);
    return () => clearInterval(timer);
    // só liga/desliga quando começa ou termina de gravar
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds === null]);

  // sair da conversa no meio da gravação solta o microfone
  useEffect(
    () => () => {
      const current = recorder.current;
      if (current) current.onstop = null;
      if (current && current.state !== "inactive") current.stop();
      releaseMic();
    },
    [releaseMic],
  );

  const start = useCallback(async (): Promise<string | null> => {
    if (starting.current || recorder.current) return null;
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return micErrorMessage("unsupported");
    starting.current = true;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecorderMime((type) => MediaRecorder.isTypeSupported(type));
      const next = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      next.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      stream.current = media;
      recorder.current = next;
      startedAt.current = Date.now();
      next.start();
      setSeconds(0);
      return null;
    } catch (error) {
      releaseMic();
      return micErrorMessage(error instanceof DOMException ? error.name : "");
    } finally {
      starting.current = false;
    }
  }, [releaseMic]);

  /** Para e devolve o áudio gravado (null se nada foi gravado). */
  const stop = useCallback((): Promise<Recording | null> => {
    const current = recorder.current;
    if (!current) return Promise.resolve(null);
    const elapsed = Math.max(0, Math.round((Date.now() - startedAt.current) / 1000));
    return new Promise((resolve) => {
      current.onstop = () => {
        const mimeType = normalizeMime(current.mimeType || chunks.current[0]?.type || "");
        const blob = new Blob(chunks.current, { type: mimeType || "audio/webm" });
        chunks.current = [];
        releaseMic();
        setSeconds(null);
        resolve(blob.size > 0 ? { blob, mimeType: blob.type, seconds: elapsed } : null);
      };
      if (current.state === "inactive") current.onstop(new Event("stop"));
      else current.stop();
    });
  }, [releaseMic]);

  /** Descarta a gravação em curso. */
  const discard = useCallback(() => {
    const current = recorder.current;
    if (current) {
      current.onstop = null;
      if (current.state !== "inactive") current.stop();
    }
    chunks.current = [];
    releaseMic();
    setSeconds(null);
  }, [releaseMic]);

  return { seconds, start, stop, discard };
}
