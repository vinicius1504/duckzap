"use client";

import type { ConversationMode, QuickReply, ReplySuggestion } from "@duckzap/contracts/conversations";
import type { MediaKind } from "@duckzap/contracts/media";
import { Button } from "@duckzap/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@duckzap/ui/components/dropdown-menu";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { Segmented } from "@duckzap/ui/components/segmented";
import { cn } from "@duckzap/ui/cn";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { acceptAttribute, mediaRulesHint, recordedFileName, validateMediaFile } from "@/lib/media";
import { rateSuggestionAction, sendTypingAction, suggestReplyAction } from "../actions";
import { createTypingPinger } from "../typing-pinger";
import { useMediaUpload, type MessageDraft as Draft, type SendOptions } from "../use-media-upload";
import { useVoiceRecorder } from "../use-voice-recorder";
import { AttachmentPreview } from "./attachment-preview";
import { formatAudioDuration } from "./view-model";

type Props = {
  conversationId: string;
  mode: ConversationMode;
  agentName: string;
  quickReplies: QuickReply[];
  /** motivo para bloquear respostas ao cliente (plano expirado); notas internas continuam liberadas */
  sendingPausedReason: string | null;
  /** envia e devolve o erro, se houver (a mensagem já aparece como "enviando") */
  onSend: (draft: Draft, options?: SendOptions) => Promise<string | null>;
};

const EMOJIS = ["😊", "🙏", "👍", "😁", "🦷", "📅", "✅", "❤️"];

export function Composer({ conversationId, mode, agentName, quickReplies, sendingPausedReason, onSend }: Props) {
  const [target, setTarget] = useState<"reply" | "note">(sendingPausedReason ? "note" : "reply");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<ReplySuggestion | null>(null);
  const [rating, setRating] = useState<"useful" | "bad" | null>(null);
  const [suggesting, startSuggest] = useTransition();
  const recorder = useVoiceRecorder();
  const recording = recorder.seconds;
  const upload = useMediaUpload(onSend);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const errorId = useId();

  // "digitando…" no WhatsApp do cliente: avisa a API ao começar a digitar e renova a cada ~4 s enquanto continuar
  // (melhor esforço, sem esperar nem mostrar erro). O conversationId mais recente vem de um ref para o aviso não
  // ficar preso à conversa anterior quando a pessoa troca de conversa.
  const conversationRef = useRef(conversationId);
  const typing = useRef<ReturnType<typeof createTypingPinger> | null>(null);
  typing.current ??= createTypingPinger({ send: () => void sendTypingAction(conversationRef.current).catch(() => undefined) });
  useEffect(() => {
    conversationRef.current = conversationId;
    const pinger = typing.current;
    return () => pinger?.stop();
  }, [conversationId]);

  // um arquivo por vez: com um escolhido ou enviando, o anexo e o microfone esperam
  const attachBusy = upload.item !== null;
  const isNote = target === "note";
  const replyBlocked = !isNote && sendingPausedReason !== null;

  // respostas rápidas: "/hor" no começo do texto abre a lista
  const slash = /^\/([a-z0-9_-]*)$/i.exec(text);
  const matches = slash ? quickReplies.filter((q) => q.shortcut.startsWith((slash[1] ?? "").toLowerCase())) : [];
  const showQuick = !isNote && slash !== null && matches.length > 0;
  const active = matches[Math.min(activeIndex, matches.length - 1)];

  useEffect(() => setActiveIndex(0), [text]);

  function pickQuickReply(reply: QuickReply) {
    setText(reply.body);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function submit(draft: Draft) {
    typing.current?.stop();
    setError(null);
    const previousText = text;
    if (draft.kind === "text" || draft.kind === "note") setText("");
    if (suggestion) setSuggestion(null);
    const problem = await onSend(draft);
    if (problem) {
      setError(problem);
      if (draft.kind === "text" || draft.kind === "note") setText(previousText);
    }
  }

  function sendText() {
    const body = text.trim();
    if (!body) {
      setError(isNote ? "Escreva a nota antes de salvar." : "Escreva a mensagem antes de enviar.");
      return;
    }
    if (replyBlocked) return;
    void submit({ kind: isNote ? "note" : "text", body, attachment: null });
  }

  /** Valida (tipo e tamanho, antes de subir qualquer byte) e mostra a pré-visualização com a legenda. */
  function pickFile(file: File, kind: Exclude<MediaKind, "audio">) {
    setError(null);
    const check = validateMediaFile(kind, file);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    upload.pick({ kind, file, fileName: file.name, mimeType: check.mimeType, sizeBytes: file.size, durationSeconds: null });
  }

  async function startRecording() {
    setError(null);
    const problem = await recorder.start();
    if (problem) setError(problem);
  }

  async function stopRecording(send: boolean) {
    if (!send) {
      recorder.discard();
      return;
    }
    const recorded = await recorder.stop();
    if (!recorded) return;
    const seconds = Math.max(1, recorded.seconds);
    const fileName = recordedFileName(recorded.mimeType, new Date());
    const check = validateMediaFile("audio", { name: fileName, type: recorded.mimeType, size: recorded.blob.size });
    if (!check.ok) {
      setError(check.message);
      return;
    }
    // o áudio vai direto pelo mesmo fluxo (progresso, erro e "tentar de novo" aparecem no cartão)
    upload.submit("", {
      kind: "audio",
      file: recorded.blob,
      fileName,
      mimeType: check.mimeType,
      sizeBytes: recorded.blob.size,
      durationSeconds: seconds,
    });
  }

  function suggest() {
    setError(null);
    startSuggest(async () => {
      const result = await suggestReplyAction(conversationId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSuggestion(result.suggestion);
      setRating(null);
      setText(result.suggestion.body);
      textareaRef.current?.focus();
    });
  }

  async function rate(value: "useful" | "bad") {
    if (!suggestion) return;
    setRating(value);
    const result = await rateSuggestionAction(suggestion.id, value);
    if (result) setError(result.error);
  }

  return (
    <div className="relative border-t border-line bg-surface px-5 pb-4 pt-3 max-md:px-3 max-md:pb-3">
      {showQuick ? (
        <div className="absolute bottom-[calc(100%-4px)] left-5 z-20 w-[min(420px,calc(100%-40px))] rounded-card border border-line bg-surface p-1.5 shadow-lg max-md:left-3 max-md:w-[calc(100%-24px)]">
          <p id={`${listboxId}-label`} className="px-2.5 py-1.5 text-xs font-bold text-ink-2">
            Respostas rápidas
          </p>
          <ul id={listboxId} role="listbox" aria-labelledby={`${listboxId}-label`}>
            {matches.map((reply) => {
              const selected = reply.id === active?.id;
              return (
                <li
                  key={reply.id}
                  id={`${listboxId}-${reply.id}`}
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickQuickReply(reply);
                  }}
                  className={cn("cursor-pointer rounded-lg px-2.5 py-2", selected && "bg-duck/15")}
                >
                  <strong>/{reply.shortcut}</strong> <span className="text-ink-2">{reply.title}</span>
                  {selected ? <span className="block truncate text-xs text-ink-2">{reply.body}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {sendingPausedReason ? (
        <Alert tone="warn" className="mb-2.5" title="Envio pausado.">
          {sendingPausedReason} Notas internas continuam liberadas.
        </Alert>
      ) : null}

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Segmented
          label="Tipo de mensagem"
          options={[
            { value: "reply", label: "Responder" },
            { value: "note", label: "Nota interna" },
          ]}
          value={target}
          onChange={(value) => {
            setTarget(value);
            setError(null);
            typing.current?.stop();
          }}
        />
        {mode === "copilot" && !isNote ? (
          <>
            <Button size="sm" onClick={suggest} disabled={suggesting || replyBlocked}>
              {suggesting ? <Spinner size={14} /> : <Icon name="sparkle" size={16} />}
              {suggesting ? "Pensando…" : "Sugerir resposta"}
            </Button>
            {suggestion ? (
              <span className="flex items-center gap-1" role="group" aria-label="Avaliar sugestão da IA">
                <button
                  type="button"
                  aria-label="Sugestão útil"
                  aria-pressed={rating === "useful"}
                  onClick={() => rate("useful")}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg border border-line hover:bg-surface-hover max-md:size-11",
                    rating === "useful" && "border-ok bg-ok-bg text-ok",
                  )}
                >
                  <Icon name="thumbUp" size={16} />
                </button>
                <button
                  type="button"
                  aria-label="Sugestão ruim"
                  aria-pressed={rating === "bad"}
                  onClick={() => rate("bad")}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg border border-line hover:bg-surface-hover max-md:size-11",
                    rating === "bad" && "border-err bg-err-bg text-err",
                  )}
                >
                  <Icon name="thumbDown" size={16} />
                </button>
                <span className="text-xs text-ink-2" aria-live="polite">
                  {rating ? "Obrigado pelo retorno!" : "Sugestão da IA: revise antes de enviar"}
                </span>
              </span>
            ) : null}
          </>
        ) : null}
        {mode === "ai" && !isNote ? (
          <span className="text-xs text-ink-2">O {agentName} está respondendo. Se você enviar, assume a conversa.</span>
        ) : null}
      </div>

      {upload.item ? (
        <AttachmentPreview
          key={`${upload.item.fileName}:${upload.item.sizeBytes}`}
          item={upload.item}
          state={upload.state}
          onSubmit={(caption) => upload.submit(caption)}
          onRetry={(caption) => upload.retry(caption)}
          onCancel={() => {
            upload.cancel();
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
        />
      ) : null}
      {/* `relative` no contêiner acima: o texto sr-only fica preso aqui */}
      <p role="status" className="sr-only">
        {upload.justSent ? "Arquivo enviado." : ""}
      </p>

      {recording !== null ? (
        <div className="flex items-center gap-2" role="status">
          <span className="size-2.5 animate-pulse rounded-full bg-err" aria-hidden="true" />
          <span className="flex-1 font-semibold tabular-nums">Gravando… {formatAudioDuration(recording)}</span>
          <Button variant="ghost" size="icon" aria-label="Descartar áudio" onClick={() => stopRecording(false)}>
            <Icon name="trash" />
          </Button>
          <Button variant="primary" className="h-11 w-12 p-0" aria-label="Enviar áudio" onClick={() => stopRecording(true)}>
            <Icon name="send" strokeWidth={2} />
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          {!isNote ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    className="max-md:size-11"
                    aria-label="Anexar arquivo"
                    disabled={replyBlocked || attachBusy}
                    title={attachBusy ? "Termine ou cancele o envio do arquivo atual" : undefined}
                  >
                    <Icon name="paperclip" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="max-w-[min(320px,calc(100vw-24px))]">
                  <DropdownMenuItem className="min-h-14 py-2" onSelect={() => imageInput.current?.click()}>
                    <Icon name="image" size={18} className="shrink-0" />
                    <span className="flex flex-col">
                      <span>Foto</span>
                      <span className="text-xs font-normal text-ink-2">{mediaRulesHint("image")}</span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem className="min-h-14 py-2" onSelect={() => docInput.current?.click()}>
                    <Icon name="file" size={18} className="shrink-0" />
                    <span className="flex flex-col">
                      <span>Documento</span>
                      <span className="text-xs font-normal text-ink-2">{mediaRulesHint("document")}</span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" className="max-md:hidden" aria-label="Emoji" disabled={replyBlocked}>
                    <Icon name="smile" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="grid min-w-0 grid-cols-4 gap-1">
                  {EMOJIS.map((emoji) => (
                    <DropdownMenuItem
                      key={emoji}
                      className="justify-center px-0 text-xl"
                      onSelect={() => {
                        setText((t) => t + emoji);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                    >
                      {emoji}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <input
                ref={imageInput}
                type="file"
                accept={acceptAttribute("image")}
                className="hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) pickFile(file, "image");
                  e.target.value = "";
                }}
              />
              <input
                ref={docInput}
                type="file"
                accept={acceptAttribute("document")}
                className="hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) pickFile(file, "document");
                  e.target.value = "";
                }}
              />
            </>
          ) : null}

          <label htmlFor={`${listboxId}-msg`} className="sr-only">
            {isNote ? "Nota interna" : "Mensagem"}
          </label>
          <textarea
            ref={textareaRef}
            id={`${listboxId}-msg`}
            rows={1}
            value={text}
            disabled={replyBlocked}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
              // só resposta ao cliente, com a IA fora de cena (modo IA ativo responde sozinho) e o envio liberado
              typing.current?.input(e.target.value, !isNote && !replyBlocked && mode !== "ai");
            }}
            onBlur={() => typing.current?.stop()}
            onKeyDown={(e) => {
              if (showQuick && active) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setActiveIndex((i) => (i + delta + matches.length) % matches.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pickQuickReply(active);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setText("");
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendText();
              }
            }}
            role={isNote ? undefined : "combobox"}
            aria-expanded={isNote ? undefined : showQuick}
            aria-controls={showQuick ? listboxId : undefined}
            aria-activedescendant={showQuick && active ? `${listboxId}-${active.id}` : undefined}
            aria-autocomplete={isNote ? undefined : "list"}
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? true : undefined}
            placeholder={
              isNote
                ? "Escreva uma nota para a equipe (o cliente não vê)"
                : replyBlocked
                  ? "Envio pausado"
                  : "Escreva uma mensagem ou / para respostas rápidas"
            }
            className={cn(
              "max-h-40 min-h-11 flex-1 resize-none rounded-control border border-field bg-surface px-3 py-2.5 text-ink [field-sizing:content] placeholder:text-ink-2 disabled:opacity-60",
              isNote && "border-dashed border-warn bg-warn-bg",
            )}
          />

          {!isNote && !text.trim() ? (
            <Button
              size="icon"
              className="max-md:size-11"
              aria-label="Gravar áudio"
              disabled={replyBlocked || upload.item !== null}
              onClick={() => void startRecording()}
            >
              <Icon name="mic" />
            </Button>
          ) : null}
          <Button
            variant="primary"
            className="h-11 w-12 p-0"
            aria-label={isNote ? "Salvar nota" : "Enviar"}
            onClick={sendText}
            disabled={replyBlocked}
          >
            <Icon name={isNote ? "note" : "send"} strokeWidth={2} />
          </Button>
        </div>
      )}

      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-[13px] font-semibold text-err">
          {error}
        </p>
      ) : null}
    </div>
  );
}
