"use client";

import type { AppointmentType, CalendarSync, ReminderSettings } from "@duckzap/contracts/appointments";
import { Button } from "@duckzap/ui/components/button";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { Dialog, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox, Textarea } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { Switch } from "@duckzap/ui/components/switch";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { createTypeAction, saveRemindersAction, setCalendarConnectedAction, setTypeActiveAction, setTypeStaffOnlyAction, syncCalendarAction } from "../actions";
import { syncView } from "../labels";
import type { AgendaPerms } from "../search-params";

const NO_PERMISSION = "Seu papel não permite. Fale com um administrador.";

function relative(iso: string | null, nowIso: string) {
  if (!iso) return "nunca";
  const min = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(iso)) / 60000));
  if (min < 1) return "agora há pouco";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `há ${h} h` : `há ${Math.round(h / 24)} dias`;
}

export function GoogleSyncCard({ sync, nowIso, perms }: { sync: CalendarSync; nowIso: string; perms: AgendaPerms }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const view = syncView[pending ? "syncing" : sync.status];

  function run(task: () => Promise<{ ok: true; data: null } | { error: string }>) {
    startTransition(async () => {
      const result = await task();
      setError("error" in result ? result.error : null);
      router.refresh();
    });
  }

  return (
    <Card className="p-[18px]">
      <div className="flex items-center justify-between gap-2">
        <CardTitle className="text-[15px]">Google Calendar</CardTitle>
        <Chip tone={view.tone} role="status">
          <span className="size-2 rounded-full bg-current" aria-hidden="true" />
          {view.label}
        </Chip>
      </div>
      <p className="mb-3 mt-2 text-ink-2">
        {sync.status === "disconnected"
          ? "Conecte para levar os agendamentos ao seu calendário e bloquear horários ocupados lá."
          : `Calendário “${sync.calendarName ?? ""}” · última sincronização ${relative(sync.lastSyncedAt, nowIso)}`}
      </p>
      {sync.status === "error" && sync.errorMessage ? <Alert tone="err" className="mb-3">{sync.errorMessage}</Alert> : null}
      {error ? <Alert tone="err" live className="mb-3">{error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        {sync.status === "disconnected" ? (
          <Button
            size="sm"
            variant="primary"
            disabled={pending || !perms.integration}
            title={perms.integration ? undefined : NO_PERMISSION}
            onClick={() => run(() => setCalendarConnectedAction(true))}
            className="max-md:h-11"
          >
            Conectar Google Calendar
          </Button>
        ) : (
          <>
            <Button size="sm" disabled={pending || !perms.manage} onClick={() => run(syncCalendarAction)} className="max-md:h-11">
              Sincronizar agora
            </Button>
            {perms.integration ? (
              <Button size="sm" disabled={pending} onClick={() => run(() => setCalendarConnectedAction(false))} className="max-md:h-11">
                Desconectar
              </Button>
            ) : null}
          </>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-2">Nos dois sentidos: eventos criados no Google ocupam o horário aqui.</p>
    </Card>
  );
}

export function TypesCard({ types, perms }: { types: AppointmentType[]; perms: AgendaPerms }) {
  const router = useRouter();
  const [optimistic, setActive] = useOptimistic(types, (state, change: { id: string; active?: boolean; staffOnly?: boolean }) =>
    state.map((t) => (t.id === change.id ? { ...t, ...(change.active === undefined ? {} : { active: change.active }), ...(change.staffOnly === undefined ? {} : { staffOnly: change.staffOnly }) } : t)),
  );
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  function toggle(type: AppointmentType, active: boolean) {
    startTransition(async () => {
      setActive({ id: type.id, active });
      const result = await setTypeActiveAction(type.id, active);
      setError("error" in result ? result.error : null);
      router.refresh();
    });
  }

  function toggleStaffOnly(type: AppointmentType, staffOnly: boolean) {
    startTransition(async () => {
      setActive({ id: type.id, staffOnly });
      const result = await setTypeStaffOnlyAction(type.id, staffOnly);
      setError("error" in result ? result.error : null);
      router.refresh();
    });
  }

  return (
    <Card className="p-[18px]">
      <div className="flex items-center justify-between gap-2">
        <CardTitle className="text-[15px]">Tipos de atendimento</CardTitle>
        {perms.settings ? (
          <Button size="sm" onClick={() => setOpen(true)} className="max-md:h-11">
            Novo
          </Button>
        ) : null}
      </div>
      {error ? <Alert tone="err" live className="mt-2">{error}</Alert> : null}
      <ul className="mt-2.5 text-[13px]">
        {optimistic.map((type) => (
          <li key={type.id} className="flex items-center gap-2.5 border-t border-line py-2.5">
            <span className="flex-1">
              <strong>{type.name}</strong>
              <br />
              <span className="text-ink-2">{type.durationMinutes} min</span>
              <br />
              <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                <Checkbox
                  checked={type.staffOnly}
                  disabled={!perms.settings}
                  onChange={(e) => toggleStaffOnly(type, e.target.checked)}
                  aria-describedby={`tipo-${type.id}-dica`}
                />
                Só a equipe marca
              </label>
              <span id={`tipo-${type.id}-dica`} className="sr-only">
                Só a equipe marca; a IA não agenda.
              </span>
            </span>
            <label htmlFor={`tipo-${type.id}`} className="text-ink-2">
              {type.active ? "Ativo" : "Inativo"}
            </label>
            <Switch
              id={`tipo-${type.id}`}
              checked={type.active}
              disabled={!perms.settings}
              onCheckedChange={(checked) => toggle(type, checked)}
              aria-label={`${type.name} ativo`}
            />
          </li>
        ))}
      </ul>
      {!perms.settings ? <p className="mt-2 text-xs text-ink-2">Só administradores mudam os tipos.</p> : null}
      <NewTypeDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}

function NewTypeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    startTransition(async () => {
      const result = await createTypeAction({
        name: String(formData.get("name") ?? ""),
        durationMinutes: Number(formData.get("duration") ?? 0),
        staffOnly: formData.get("staffOnly") === "on",
      });
      if ("error" in result) return setError(result.error);
      setError(null);
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title="Novo tipo de atendimento" description="A duração define quanto tempo o horário fica ocupado.">
        <form action={submit} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="tipo-nome">Nome</Label>
            <Input id="tipo-nome" name="name" required maxLength={60} placeholder="Ex.: Extração" />
          </div>
          <div>
            <Label htmlFor="tipo-dur">Duração (min)</Label>
            <Input id="tipo-dur" name="duration" type="number" min={5} max={480} step={5} defaultValue={30} required />
          </div>
          <div>
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox name="staffOnly" />
              Só a equipe marca
            </label>
            <p className="mt-1 text-xs text-ink-2">Só a equipe marca; a IA não agenda.</p>
          </div>
          {error ? <Alert tone="err" live>{error}</Alert> : null}
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Salvando…" : "Criar tipo"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RemindersCard({ settings, perms }: { settings: ReminderSettings; perms: AgendaPerms }) {
  const router = useRouter();
  const [draft, setDraft] = useState(settings);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const readOnly = !perms.settings;

  function patch(kind: "24h" | "2h", change: Partial<ReminderSettings["reminders"][number]>) {
    setDraft((d) => ({ ...d, reminders: d.reminders.map((r) => (r.kind === kind ? { ...r, ...change } : r)) }));
  }

  function save() {
    startTransition(async () => {
      const result = await saveRemindersAction(draft);
      setMessage("error" in result ? { tone: "err", text: result.error } : { tone: "ok", text: "Lembretes salvos." });
      router.refresh();
    });
  }

  return (
    <Card className="p-[18px]">
      <CardTitle className="text-[15px]">Lembretes automáticos</CardTitle>
      <p className="mt-1 text-[13px] text-ink-2">Enviados pelo WhatsApp do canal da conversa. Variáveis: {"{nome}"}, {"{hora}"}, {"{data}"}, {"{tipo}"}.</p>
      <div className="mt-3 flex flex-col gap-4">
        {draft.reminders.map((r) => (
          <div key={r.kind} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`lembrete-${r.kind}`} className="text-[13px] font-semibold">
                {r.kind === "24h" ? "24 horas antes" : "2 horas antes"}
              </label>
              <Switch
                id={`lembrete-${r.kind}`}
                checked={r.enabled}
                disabled={readOnly}
                onCheckedChange={(enabled) => patch(r.kind, { enabled })}
              />
            </div>
            <label htmlFor={`lembrete-msg-${r.kind}`} className="sr-only">
              Mensagem do lembrete {r.kind === "24h" ? "de 24 horas" : "de 2 horas"}
            </label>
            <Textarea
              id={`lembrete-msg-${r.kind}`}
              rows={3}
              value={r.message}
              disabled={readOnly || !r.enabled}
              onChange={(e) => patch(r.kind, { message: e.target.value })}
            />
          </div>
        ))}
        <div className="flex items-start justify-between gap-3 rounded-control bg-surface-2 p-3">
          <label htmlFor="confirmar-resposta" className="text-[13px]">
            <strong className="block">Confirmar pela resposta</strong>
            <span className="text-ink-2">1 ou SIM → Confirmado. 2 ou REMARCAR → A remarcar e a conversa vai para a equipe.</span>
          </label>
          <Switch
            id="confirmar-resposta"
            checked={draft.confirmByReply}
            disabled={readOnly}
            onCheckedChange={(confirmByReply) => setDraft((d) => ({ ...d, confirmByReply }))}
          />
        </div>
        {message ? (
          <Alert tone={message.tone} live>
            {message.text}
          </Alert>
        ) : null}
        {readOnly ? (
          <p className="text-xs text-ink-2">Só administradores mudam os lembretes.</p>
        ) : (
          <Button variant="primary" onClick={save} disabled={pending}>
            {pending ? "Salvando…" : "Salvar lembretes"}
          </Button>
        )}
      </div>
    </Card>
  );
}
