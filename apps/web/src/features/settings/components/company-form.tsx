"use client";

import type { Company } from "@duckzap/contracts/settings";
import { initialsOf } from "@duckzap/ui/components/avatar";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Alert } from "@duckzap/ui/components/feedback";
import { Select } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { useState, useTransition } from "react";
import { updateCompanyAction } from "../actions";
import { summarizeBusinessHours } from "./business-hours";
import { BusinessHoursEditor } from "./business-hours-editor";

const timeZones = [
  { value: "America/Noronha", label: "Fernando de Noronha (UTC−2)" },
  { value: "America/Sao_Paulo", label: "Brasília, São Paulo, Rio (UTC−3)" },
  { value: "America/Bahia", label: "Bahia (UTC−3)" },
  { value: "America/Fortaleza", label: "Fortaleza, Nordeste (UTC−3)" },
  { value: "America/Recife", label: "Recife (UTC−3)" },
  { value: "America/Belem", label: "Belém (UTC−3)" },
  { value: "America/Campo_Grande", label: "Campo Grande (UTC−4)" },
  { value: "America/Cuiaba", label: "Cuiabá (UTC−4)" },
  { value: "America/Manaus", label: "Manaus (UTC−4)" },
  { value: "America/Porto_Velho", label: "Porto Velho (UTC−4)" },
  { value: "America/Boa_Vista", label: "Boa Vista (UTC−4)" },
  { value: "America/Rio_Branco", label: "Rio Branco (UTC−5)" },
];

export function CompanyForm({ company }: { company: Company }) {
  const [form, setForm] = useState(company);
  const [editingHours, setEditingHours] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof Company>(key: K, value: Company[K]) => setForm((f) => ({ ...f, [key]: value }));

  function save() {
    const { logoUrl: _logo, ...input } = form;
    startTransition(async () => {
      const result = await updateCompanyAction(input);
      setFeedback(result.ok ? { tone: "ok", text: "Alterações salvas." } : { tone: "err", text: result.error });
      if (result.ok) setEditingHours(false);
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
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex size-18 items-center justify-center rounded-2xl bg-surface-2 text-[22px] font-extrabold" aria-hidden="true">
            {initialsOf(form.name || "?")}
          </span>
          <div>
            <p className="font-bold">Logo da empresa</p>
            <p className="text-[13px] text-ink-2">Envio de logo em breve</p>
          </div>
          <Button size="sm" disabled title="Envio de logo em breve">
            Trocar logo
          </Button>
        </div>

        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))]">
          <div>
            <Label htmlFor="empresa-nome">Nome da empresa</Label>
            <Input id="empresa-nome" value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} required className="h-10" />
          </div>
          <div>
            <Label htmlFor="empresa-segmento">Segmento</Label>
            <Input id="empresa-segmento" value={form.segment} onChange={(e) => set("segment", e.target.value)} maxLength={60} className="h-10" />
          </div>
          <div>
            <Label htmlFor="empresa-telefone">Telefone de contato</Label>
            <Input id="empresa-telefone" type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={20} className="h-10" />
          </div>
          <div>
            <Label htmlFor="empresa-email">E-mail</Label>
            <Input id="empresa-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} className="h-10" />
          </div>
          <div>
            <Label htmlFor="empresa-fuso">Fuso horário</Label>
            <Select id="empresa-fuso" value={form.timeZone} onChange={(e) => set("timeZone", e.target.value)} aria-describedby="empresa-fuso-dica">
              {timeZones.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
            </Select>
            <p id="empresa-fuso-dica" className="mt-1 text-xs text-ink-2">
              Usado em horários de mensagens, agenda e relatórios.
            </p>
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-[13px] font-semibold">Horário de atendimento padrão</p>
          {editingHours ? (
            <BusinessHoursEditor idPrefix="empresa-horario" value={form.businessHours} onChange={(v) => set("businessHours", v)} />
          ) : (
            <>
              <p className="text-ink-2">
                {summarizeBusinessHours(form.businessHours)
                  .map((row) => `${row.label} ${row.text === "Fechado" ? "fechado" : row.text}`)
                  .join(" · ")}
              </p>
              <Button size="sm" className="mt-2" onClick={() => setEditingHours(true)}>
                Editar horário
              </Button>
            </>
          )}
          <p className="mt-1.5 text-xs text-ink-2">Equipes podem ter horário próprio, em Equipe.</p>
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
