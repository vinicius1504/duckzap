"use client";

import type { ServiceSettings } from "@duckzap/contracts/settings";
import { Button } from "@duckzap/ui/components/button";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox, Select, Textarea } from "@duckzap/ui/components/form-controls";
import { Label } from "@duckzap/ui/components/input";
import { useState, useTransition } from "react";
import { updateServiceSettingsAction } from "../actions";

const firstOptions = [2, 6, 24] as const;
const secondOptions = [24, 48] as const;
const closeOptions = [3, 7] as const;

export function ServiceForm({ settings }: { settings: ServiceSettings }) {
  const [form, setForm] = useState(settings);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const result = await updateServiceSettingsAction(form);
      setFeedback(result.ok ? { tone: "ok", text: "Alterações salvas." } : { tone: "err", text: result.error });
    });
  }

  return (
    <Card className="p-6 max-sm:p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex flex-col gap-[18px]"
        noValidate
      >
        <div>
          <CardTitle>Follow-up padrão</CardTitle>
          <p className="text-[13px] text-ink-2">Usado por agentes que não têm sequência própria.</p>
        </div>
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))]">
          <div>
            <Label htmlFor="followup-1">Primeiro lembrete após</Label>
            <Select
              id="followup-1"
              value={String(form.followUp.firstReminderHours)}
              onChange={(e) => {
                const value = firstOptions.find((o) => String(o) === e.target.value);
                if (value) setForm((f) => ({ ...f, followUp: { ...f.followUp, firstReminderHours: value } }));
              }}
            >
              {firstOptions.map((h) => (
                <option key={h} value={h}>
                  {h} horas
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="followup-2">Segundo lembrete após</Label>
            <Select
              id="followup-2"
              value={form.followUp.secondReminderHours === null ? "" : String(form.followUp.secondReminderHours)}
              onChange={(e) => {
                const value = secondOptions.find((o) => String(o) === e.target.value) ?? null;
                setForm((f) => ({ ...f, followUp: { ...f.followUp, secondReminderHours: value } }));
              }}
            >
              {secondOptions.map((h) => (
                <option key={h} value={h}>
                  {h} horas
                </option>
              ))}
              <option value="">Não enviar</option>
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="followup-msg">Mensagem automática de retomada</Label>
          <Textarea
            id="followup-msg"
            rows={2}
            maxLength={500}
            value={form.followUp.message}
            onChange={(e) => setForm((f) => ({ ...f, followUp: { ...f.followUp, message: e.target.value } }))}
            aria-describedby="followup-msg-dica"
          />
          <p id="followup-msg-dica" className="mt-1 text-xs text-ink-2">
            Use {"{nome}"} para o primeiro nome do cliente.
          </p>
        </div>

        <div>
          <CardTitle className="mb-2">Encerramento por inatividade</CardTitle>
          <div className="flex flex-wrap items-center gap-2.5">
            <label className="flex min-h-11 items-center gap-2.5">
              <Checkbox
                checked={form.inactivityClose.enabled}
                onChange={(e) => setForm((f) => ({ ...f, inactivityClose: { ...f.inactivityClose, enabled: e.target.checked } }))}
              />
              Resolver conversas sem resposta do cliente após
            </label>
            <label htmlFor="inatividade-prazo" className="sr-only">
              Prazo
            </label>
            <Select
              id="inatividade-prazo"
              className="w-28"
              disabled={!form.inactivityClose.enabled}
              value={String(form.inactivityClose.days)}
              onChange={(e) => {
                const value = closeOptions.find((o) => String(o) === e.target.value);
                if (value) setForm((f) => ({ ...f, inactivityClose: { ...f.inactivityClose, days: value } }));
              }}
            >
              {closeOptions.map((d) => (
                <option key={d} value={d}>
                  {d} dias
                </option>
              ))}
            </Select>
          </div>
        </div>

        {feedback ? (
          <Alert tone={feedback.tone} live>
            {feedback.text}
          </Alert>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Salvando…" : "Salvar alterações"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
