"use client";

import {
  agentDraftSchema,
  type AgentDraft,
  type AgentTone,
  type PreviewMessage,
} from "@duckzap/contracts/onboarding";
import { brand } from "@duckzap/brand";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Select, Textarea } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { FieldError, Label } from "@duckzap/ui/components/input";
import { cn } from "@duckzap/ui/cn";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { completeOnboardingAction, previewReplyAction } from "../actions";

const tones: { value: AgentTone; label: string }[] = [
  { value: "friendly", label: "Amigável" },
  { value: "formal", label: "Formal" },
  { value: "direct", label: "Direto" },
];

const suggestions = [
  "Quanto custa?",
  "Vocês abrem sábado?",
  "Quero marcar um horário",
  "Quero falar com uma pessoa",
];

export function AgentStep({
  defaults,
  sample,
}: {
  defaults: AgentDraft;
  sample: PreviewMessage[];
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [skipping, startSkip] = useTransition();
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<AgentDraft>({ resolver: zodResolver(agentDraftSchema), defaultValues: defaults });
  const tone = watch("tone");

  async function finish(agent: AgentDraft | null) {
    setServerError(null);
    const result = await completeOnboardingAction(agent);
    if (result) {
      setServerError(result.error);
      return;
    }
    router.replace("/comecar?passo=pronto");
    router.refresh();
  }

  const busy = isSubmitting || skipping;

  return (
    <form
      noValidate
      onSubmit={handleSubmit((values) => finish(values))}
      className="flex flex-col gap-6"
    >
      <div>
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">
          Crie o seu primeiro agente
        </h1>
        <p className="mt-1.5 text-ink-2">
          Responda algumas perguntas. Você pode ajustar tudo depois em Agentes de IA. O agente só
          começa a responder clientes quando o seu WhatsApp estiver conectado.
        </p>
      </div>

      {serverError ? (
        <Alert tone="err" live>
          {serverError}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-start gap-6">
        <Card className="flex min-w-0 flex-[1_1_420px] flex-col gap-4 p-7 max-sm:p-4">
          <div>
            <Label htmlFor="agente-objetivo">Qual é o objetivo?</Label>
            <Select id="agente-objetivo" className="h-11" {...register("goal")}>
              <option value="support">Atender e tirar dúvidas</option>
              <option value="sales">Vender</option>
              <option value="scheduling">Agendar horários</option>
            </Select>
          </div>

          <fieldset>
            <legend className="mb-1.5 text-[13px] font-semibold">Tom de voz</legend>
            <div className="flex flex-wrap gap-2">
              {tones.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  aria-pressed={tone === t.value}
                  onClick={() => setValue("tone", t.value)}
                  className={cn(
                    "min-h-11 rounded-control border border-line bg-surface px-4 font-semibold hover:bg-surface-hover",
                    tone === t.value && "border-ink bg-ink text-bg hover:bg-ink",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div>
            <Label htmlFor="agente-oferta">O que você vende?</Label>
            <Textarea
              id="agente-oferta"
              rows={2}
              placeholder="Limpeza, clareamento, restauração e tratamento de canal"
              invalid={Boolean(errors.offering)}
              aria-describedby={errors.offering ? "agente-oferta-erro" : undefined}
              {...register("offering")}
            />
            <FieldError id="agente-oferta-erro" message={errors.offering?.message} />
          </div>
          <div>
            <Label htmlFor="agente-regras">Alguma regra importante?</Label>
            <Textarea
              id="agente-regras"
              rows={2}
              placeholder="Nunca passar preço de canal por mensagem. Sempre oferecer avaliação."
              invalid={Boolean(errors.rules)}
              {...register("rules")}
            />
            <FieldError id="agente-regras-erro" message={errors.rules?.message} />
          </div>
          <div>
            <Label htmlFor="agente-pessoa">Quando chamar uma pessoa?</Label>
            <Textarea
              id="agente-pessoa"
              rows={2}
              invalid={Boolean(errors.handoffWhen)}
              {...register("handoffWhen")}
            />
            <FieldError id="agente-pessoa-erro" message={errors.handoffWhen?.message} />
          </div>
        </Card>

        <Preview sample={sample} getAgent={() => getValues()} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button size="lg" onClick={() => router.push("/comecar?passo=whatsapp")} disabled={busy}>
          Voltar
        </Button>
        <div className="flex flex-wrap gap-3">
          <Button size="lg" disabled={busy} onClick={() => startSkip(() => finish(null))}>
            {skipping ? <Spinner /> : null}
            Pular por agora
          </Button>
          <Button type="submit" size="lg" variant="primary" disabled={busy}>
            {isSubmitting ? <Spinner /> : null}
            {isSubmitting ? "Criando seu agente…" : "Criar agente e concluir"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Conversa simulada com o agente usando o que está no formulário agora. Nada é enviado. */
function Preview({ sample, getAgent }: { sample: PreviewMessage[]; getAgent: () => AgentDraft }) {
  const [messages, setMessages] = useState<PreviewMessage[]>(sample);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, pending]);

  function send(message: string) {
    const value = message.trim();
    if (!value || pending) return;
    setError(null);
    setText("");
    const history = messages;
    setMessages([...history, { from: "customer", text: value }]);
    startTransition(async () => {
      const agent = getAgent();
      const result = await previewReplyAction(
        {
          ...agent,
          offering: agent.offering.trim().length >= 3 ? agent.offering : "nossos serviços",
        },
        history,
        value,
      );
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setMessages((current) => [...current, { from: "agent", text: result.reply }]);
    });
  }

  return (
    <aside
      className="flex min-w-0 flex-[1_1_340px] flex-col overflow-hidden rounded-card border border-line bg-surface"
      aria-label="Prévia do agente"
    >
      <div className="flex items-start justify-between gap-3 border-b border-line px-[18px] py-3.5">
        <div>
          <strong>Prévia do agente</strong>
          <p className="text-xs text-ink-2">Simulação. Nada é enviado.</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setMessages([])}
          disabled={pending || messages.length === 0}
        >
          Limpar
        </Button>
      </div>
      <ol
        ref={listRef}
        aria-live="polite"
        className="flex max-h-[360px] min-h-[260px] flex-col gap-2.5 overflow-y-auto bg-bg p-4"
      >
        {messages.length === 0 ? (
          <li className="m-auto max-w-60 text-center text-[13px] text-ink-2">
            Escreva como se fosse um cliente para ver a resposta.
          </li>
        ) : null}
        {messages.map((m, i) => (
          <li
            key={i}
            className={cn(
              "max-w-[90%] whitespace-pre-wrap px-3 py-2",
              m.from === "customer"
                ? "self-end rounded-[14px_14px_4px_14px] bg-duck text-on-duck"
                : "self-start rounded-[14px_14px_14px_4px] border border-line bg-surface",
            )}
          >
            <span className="sr-only">
              {m.from === "customer" ? "Cliente: " : `${brand.agentName}: `}
            </span>
            {m.text}
          </li>
        ))}
        {pending ? (
          <li className="flex items-center gap-2 self-start text-[13px] text-ink-2">
            <Spinner size={14} /> {brand.agentName} está digitando…
          </li>
        ) : null}
      </ol>
      {error ? (
        <p role="alert" className="px-4 pt-2 text-[13px] font-semibold text-err">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5 px-4 pt-3">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => send(s)}
            disabled={pending}
            className="min-h-9 rounded-full border border-line px-3 text-xs font-semibold hover:bg-surface-hover disabled:opacity-60"
          >
            {s}
          </button>
        ))}
      </div>
      <div className="flex gap-2 p-4">
        <label htmlFor="previa-mensagem" className="sr-only">
          Mensagem de teste
        </label>
        <input
          id="previa-mensagem"
          value={text}
          maxLength={500}
          placeholder="Escreva como um cliente…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // o campo está dentro do formulário do agente: Enter envia a mensagem de teste, não o formulário
            if (e.key === "Enter") {
              e.preventDefault();
              send(text);
            }
          }}
          className="h-11 min-w-0 flex-1 rounded-control border border-field bg-surface px-3 text-ink placeholder:text-ink-2"
        />
        <Button
          variant="primary"
          size="icon"
          className="size-11"
          aria-label="Enviar mensagem de teste"
          disabled={pending || !text.trim()}
          onClick={() => send(text)}
        >
          <Icon name="send" size={18} />
        </Button>
      </div>
    </aside>
  );
}
