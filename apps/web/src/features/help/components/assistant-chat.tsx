"use client";

import type { AssistantMessage } from "@duckzap/contracts/help";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Icon } from "@duckzap/ui/components/icon";
import { Input } from "@duckzap/ui/components/input";
import { Spinner } from "@duckzap/ui/components/feedback";
import { cn } from "@duckzap/ui/cn";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { askAssistantAction } from "../actions";

const welcome: AssistantMessage = {
  id: "ast_welcome",
  role: "assistant",
  text: "Oi! Pergunte como fazer algo no Duckzap. Ex.: “como faço o agente chamar uma pessoa?”",
  sources: [],
};

export function AssistantChat() {
  const [messages, setMessages] = useState<AssistantMessage[]>([welcome]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, pending]);

  function submit(formData: FormData) {
    const question = String(formData.get("question") ?? "").trim();
    if (!question) {
      setError("Escreva sua dúvida.");
      return;
    }
    setError(null);
    setMessages((m) => [...m, { id: `usr_${m.length}`, role: "user", text: question, sources: [] }]);
    formRef.current?.reset();
    startTransition(async () => {
      const result = await askAssistantAction(question);
      if (result.ok) setMessages((m) => [...m, result.data]);
      else setError(result.error);
    });
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-[18px] py-3.5">
        <h2 className="font-bold">Assistente de ajuda</h2>
        <p className="text-xs text-ink-2">Pergunte como fazer algo no Duckzap</p>
      </div>
      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-label="Conversa com o assistente"
        className="flex max-h-90 min-h-50 flex-col gap-2.5 overflow-y-auto bg-bg p-4"
      >
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "max-w-[90%] px-3 py-2",
              message.role === "user"
                ? "self-end rounded-[14px_14px_4px_14px] bg-duck text-on-duck"
                : "self-start rounded-[14px_14px_14px_4px] border border-line bg-surface",
            )}
          >
            <span className="sr-only">{message.role === "user" ? "Você:" : "Assistente:"}</span>
            {message.text}
            {message.sources.length ? (
              <p className="mt-1.5 text-xs text-ink-2">
                Veja em:{" "}
                {message.sources.map((source) => (
                  <Link key={source.href} href={source.href} className="font-semibold underline">
                    {source.title}
                  </Link>
                ))}
              </p>
            ) : null}
          </div>
        ))}
        {pending ? (
          <div className="flex items-center gap-2 self-start rounded-[14px_14px_14px_4px] border border-line bg-surface px-3 py-2 text-ink-2">
            <Spinner size={14} /> Procurando na ajuda…
          </div>
        ) : null}
      </div>
      <form ref={formRef} action={submit} className="flex gap-2 border-t border-line p-3">
        <label htmlFor="pergunta-ajuda" className="sr-only">
          Pergunta
        </label>
        <Input
          id="pergunta-ajuda"
          name="question"
          placeholder="Escreva sua dúvida"
          maxLength={500}
          autoComplete="off"
          className="h-11"
          aria-describedby={error ? "pergunta-ajuda-erro" : undefined}
        />
        <Button type="submit" variant="primary" size="icon" aria-label="Enviar pergunta" disabled={pending} className="size-11 shrink-0">
          <Icon name="send" size={18} strokeWidth={2} />
        </Button>
      </form>
      {error ? (
        <p id="pergunta-ajuda-erro" role="alert" className="px-3 pb-3 text-[13px] font-semibold text-err">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
