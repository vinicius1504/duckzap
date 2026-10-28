"use client";

import type { Channel, ChannelMessages, InactivityTransferMinutes, LinkOption, ReplyMode } from "@duckzap/contracts/channels";
import { Button } from "@duckzap/ui/components/button";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox, Radio, Select, Textarea } from "@duckzap/ui/components/form-controls";
import { Label } from "@duckzap/ui/components/input";
import { cn } from "@duckzap/ui/cn";
import { useState, useTransition } from "react";
import { updateChannelSettingsAction } from "../actions";
import { inactivityOptions, replyModeOptions } from "./labels";

const messageFields: { key: keyof ChannelMessages; label: string; hint: string }[] = [
  { key: "welcome", label: "Boas-vindas", hint: "Primeira resposta de uma conversa nova." },
  { key: "outOfHours", label: "Fora do horário", hint: "Enviada fora do horário da equipe." },
  { key: "closing", label: "Encerramento", hint: "Enviada quando a conversa é resolvida." },
  { key: "rating", label: "Avaliação", hint: "Pergunta de satisfação depois do encerramento." },
];

/** Textos que o SISTEMA manda antes da IA: só existem no modo "Automático, sem IA". */
const automaticKeys: readonly (keyof ChannelMessages)[] = ["welcome", "outOfHours"];

/** Vínculo canal → equipe → agente, mensagens do canal e transferência por inatividade. */
export function ChannelSettingsForm({
  channel,
  teams,
  agents,
}: {
  channel: Channel;
  teams: LinkOption[];
  agents: LinkOption[];
}) {
  const [teamId, setTeamId] = useState(channel.teamId ?? "");
  const [agentId, setAgentId] = useState(channel.agentId ?? "");
  const [replyMode, setReplyMode] = useState<ReplyMode>(channel.replyMode);
  const [signMessages, setSignMessages] = useState(channel.signMessages);
  // os quatro textos ficam sempre no estado (e vão no salvar): esconder os automáticos nunca apaga o que foi digitado ou gravado
  const [messages, setMessages] = useState(channel.messages);
  const [inactivity, setInactivity] = useState<InactivityTransferMinutes>(channel.inactivityTransferMinutes);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const id = (field: string) => `canal-${channel.id}-${field}`;

  function save() {
    startTransition(async () => {
      const result = await updateChannelSettingsAction(channel.id, {
        teamId: teamId || null,
        agentId: agentId || null,
        replyMode,
        signMessages,
        messages,
        inactivityTransferMinutes: inactivity,
      });
      setFeedback(result.ok ? { tone: "ok", text: "Alterações salvas." } : { tone: "err", text: result.error });
    });
  }

  return (
    <Card id="mensagens" className="flex scroll-mt-20 flex-col gap-3.5 p-[22px] max-sm:p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Mensagens do canal · {channel.name}</CardTitle>
          <Button type="submit" variant="primary" size="sm" disabled={pending}>
            {pending ? "Salvando…" : "Salvar"}
          </Button>
        </div>
        {feedback ? (
          <Alert tone={feedback.tone} live>
            {feedback.text}
          </Alert>
        ) : null}

        <fieldset className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))]">
          <legend className="mb-2 text-[13px] font-bold text-ink-2">Quem atende</legend>
          <div>
            <Label htmlFor={id("equipe")}>Equipe</Label>
            <Select id={id("equipe")} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">Sem equipe</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor={id("agente")}>Agente de IA</Label>
            <Select id={id("agente")} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Sem agente (só pessoas)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
        </fieldset>

        <fieldset role="radiogroup" className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-bold text-ink-2">Como este canal responde</legend>
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))]">
            {replyModeOptions.map((option) => {
              const checked = replyMode === option.value;
              return (
                <label
                  key={option.value}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-start gap-3 rounded-control border border-line bg-surface p-3.5 hover:bg-surface-hover",
                    checked && "border-ink ring-1 ring-ink",
                  )}
                >
                  <Radio
                    name={id("modo")}
                    value={option.value}
                    checked={checked}
                    onChange={() => setReplyMode(option.value)}
                    aria-describedby={id(`modo-${option.value}-dica`)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{option.label}</span>
                    <span id={id(`modo-${option.value}-dica`)} className="mt-0.5 block text-xs text-ink-2">
                      {option.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {replyMode === "ai" ? (
          <p className="text-[13px] text-ink-2">
            Com Somente IA, o agente cuida da saudação e dos horários. Para usar mensagens automáticas, mude o modo de resposta.
          </p>
        ) : null}

        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-control border border-line bg-surface p-3.5 hover:bg-surface-hover">
          <Checkbox
            checked={signMessages}
            onChange={(e) => setSignMessages(e.target.checked)}
            aria-describedby={id("assinatura-dica")}
            className="mt-0.5"
          />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">Assinar as mensagens com o nome de quem atende</span>
            <span id={id("assinatura-dica")} className="mt-0.5 block text-xs text-ink-2">
              O cliente vê quem está falando, por exemplo <strong>*Rafael (Vendas):*</strong> antes do texto. Vale para mensagens de
              pessoas, nunca para as da IA. Ajuda quando o mesmo WhatsApp é atendido por várias pessoas e setores.
            </span>
          </span>
        </label>

        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr))]">
          {messageFields
            .filter((field) => replyMode === "auto" || !automaticKeys.includes(field.key))
            .map((field) => (
              <div key={field.key}>
                <Label htmlFor={id(field.key)}>{field.label}</Label>
                <Textarea
                  id={id(field.key)}
                  rows={3}
                  maxLength={1000}
                  value={messages[field.key]}
                  placeholder="Deixe em branco para não enviar"
                  aria-describedby={id(`${field.key}-dica`)}
                  onChange={(e) => setMessages((m) => ({ ...m, [field.key]: e.target.value }))}
                />
                <p id={id(`${field.key}-dica`)} className="mt-1 text-xs text-ink-2">
                  {field.hint}
                </p>
              </div>
            ))}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <label htmlFor={id("inatividade")}>Transferir para a equipe após</label>
          <Select
            id={id("inatividade")}
            value={String(inactivity)}
            onChange={(e) => {
              const option = inactivityOptions.find((o) => String(o.value) === e.target.value);
              if (option) setInactivity(option.value);
            }}
            className="w-35"
          >
            {inactivityOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <span className="text-ink-2">sem resposta do cliente</span>
        </div>
      </form>
    </Card>
  );
}
