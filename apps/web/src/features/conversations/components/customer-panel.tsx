"use client";

import type { ContactProfile, ConversationSummary, InboxLookups } from "@duckzap/contracts/conversations";
import { Avatar } from "@duckzap/ui/components/avatar";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Chip, type ChipTone } from "@duckzap/ui/components/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@duckzap/ui/components/dropdown-menu";
import { Select, Textarea } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import Link from "next/link";
import { useOptimistic, useState, useTransition, type ReactNode } from "react";
import { formatDate, formatPhone } from "@/lib/format";
import {
  moveConversationStageAction,
  setContactTagsAction,
  setContactTaskDoneAction,
  updateContactNotesAction,
} from "../actions";
import { APPOINTMENT_STATUS, NO_PERMISSION_HINT, stagesOf, whenLabel } from "./view-model";

const CONSENT: Record<ContactProfile["consent"], { label: string; tone: ChipTone }> = {
  granted: { label: "Aceita disparos", tone: "neutral" },
  pending: { label: "Opt-in pendente", tone: "warn" },
  denied: { label: "Não aceita disparos", tone: "err" },
  expired: { label: "Opt-in expirado", tone: "warn" },
};

type Props = {
  conversation: ConversationSummary;
  contact: ContactProfile;
  lookups: InboxLookups;
  canEdit: boolean;
  canSchedule: boolean;
  onSchedule: () => void;
  nowIso: string;
  timeZone: string;
};

export function CustomerPanel({ conversation, contact, lookups, canEdit, canSchedule, onSchedule, nowIso, timeZone }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [stageId, setStage] = useOptimistic(conversation.stageId);
  const [tagIds, setTags] = useOptimistic(conversation.tagIds);
  const [tasks, setTask] = useOptimistic(contact.tasks, (state, change: { id: string; done: boolean }) =>
    state.map((t) => (t.id === change.id ? { ...t, done: change.done } : t)),
  );

  const stages = stagesOf(lookups);
  const otherTags = lookups.tags.filter((t) => t.funnelStage === null);
  const nowMs = new Date(nowIso).getTime();
  const upcoming = contact.appointments
    .filter((a) => new Date(a.startsAt).getTime() >= nowMs && a.status !== "canceled")
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  function run(optimistic: () => void, action: () => Promise<{ error: string } | null>) {
    setError(null);
    startTransition(async () => {
      optimistic();
      const result = await action();
      if (result) setError(result.error);
    });
  }

  function toggleTag(tagId: string) {
    const next = tagIds.includes(tagId) ? tagIds.filter((t) => t !== tagId) : [...tagIds, tagId];
    run(
      () => setTags(next),
      () => setContactTagsAction(contact.id, next),
    );
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-col items-center gap-1 text-center">
        <Avatar name={contact.name} size="lg" />
        <strong className="mt-1.5 text-lg">{contact.name}</strong>
        {contact.handle ? <span className="text-ink-2">@{contact.handle} · Instagram</span> : null}
        {contact.phone ? <span className="text-ink-2">{formatPhone(contact.phone)}</span> : null}
        {contact.email ? <span className="break-all text-ink-2">{contact.email}</span> : null}
      </div>

      <div className="flex flex-wrap justify-center gap-1.5">
        <Chip tone={contact.isCustomer ? "ok" : "info"}>{contact.isCustomer ? "Cliente" : "Novo contato"}</Chip>
        {tagIds.map((id) => {
          const tag = lookups.tags.find((t) => t.id === id);
          return tag ? (
            <Chip key={id} tone="info">
              {tag.name}
            </Chip>
          ) : null;
        })}
        <Chip tone={CONSENT[contact.consent].tone}>{CONSENT[contact.consent].label}</Chip>
      </div>

      {error ? (
        <p role="alert" className="text-center text-[13px] font-semibold text-err">
          {error}
        </p>
      ) : null}

      <Section title="Etapa do funil">
        <label htmlFor={`stage-${conversation.id}`} className="sr-only">
          Etapa do funil
        </label>
        <Select
          id={`stage-${conversation.id}`}
          value={stageId}
          disabled={!canEdit}
          title={canEdit ? undefined : NO_PERMISSION_HINT}
          onChange={(e) => {
            const next = e.target.value;
            run(
              () => setStage(next),
              () => moveConversationStageAction(conversation.id, next),
            );
          }}
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="mt-2 max-md:h-11" disabled={!canEdit} title={canEdit ? undefined : NO_PERMISSION_HINT}>
              <Icon name="tag" size={16} />
              Etiquetas
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Etiquetas do cliente</DropdownMenuLabel>
            {otherTags.map((tag) => {
              const checked = tagIds.includes(tag.id);
              return (
                <DropdownMenuItem
                  key={tag.id}
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  onSelect={(e) => {
                    e.preventDefault();
                    toggleTag(tag.id);
                  }}
                >
                  <span className={cn("flex size-4 items-center justify-center rounded border border-field", checked && "border-ink bg-ink text-bg")}>
                    {checked ? <Icon name="check" size={12} strokeWidth={3} /> : null}
                  </span>
                  {tag.name}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      <Section
        title={upcoming.length > 1 ? "Próximos agendamentos" : "Próximo agendamento"}
        action={
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 max-md:h-11"
            onClick={onSchedule}
            disabled={!canSchedule || conversation.status === "resolved"}
            title={canSchedule ? undefined : NO_PERMISSION_HINT}
          >
            <Icon name="plus" size={14} />
            Agendar
          </Button>
        }
      >
        {upcoming.length === 0 ? (
          <p className="text-ink-2">Nenhum agendamento futuro.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {upcoming.map((a) => (
              <li key={a.id} className="rounded-card border border-line p-3">
                <strong>{whenLabel(a.startsAt, nowIso, timeZone)}</strong>
                <p className="text-[13px] text-ink-2">
                  {a.typeName} · {a.professional} ·{" "}
                  <span className={APPOINTMENT_STATUS[a.status].tone === "warn" ? "font-semibold text-warn" : undefined}>
                    {APPOINTMENT_STATUS[a.status].label}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Tarefas do cliente">
        {tasks.length === 0 ? (
          <p className="text-ink-2">Nenhuma tarefa.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((task) => (
              <li key={task.id}>
                <label className="flex min-h-11 items-start gap-2.5 md:min-h-0">
                  <input
                    type="checkbox"
                    checked={task.done}
                    disabled={!canEdit}
                    onChange={() =>
                      run(
                        () => setTask({ id: task.id, done: !task.done }),
                        () => setContactTaskDoneAction(task.id, !task.done),
                      )
                    }
                    className="mt-0.5 size-[18px] shrink-0 accent-ink"
                  />
                  <span className={cn(task.done && "text-ink-2 line-through")}>
                    {task.title}
                    {task.dueAt ? (
                      <span className="block text-xs text-ink-2">{whenLabel(task.dueAt, nowIso, timeZone)}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <NotesEditor key={contact.id} contactId={contact.id} initial={contact.notes} canEdit={canEdit} />

      <Section title="Histórico">
        {contact.history.length === 0 ? (
          <p className="text-ink-2">Primeira conversa com a clínica.</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {contact.history.map((h) => (
              <li key={h.id} className="flex justify-between gap-3">
                <span>{h.title}</span>
                <span className="shrink-0 text-ink-2">{formatDate(h.at, { day: "2-digit", month: "2-digit" }, timeZone)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Link href={`/clientes?ficha=${contact.id}`} className={buttonVariants({ size: "sm", className: "max-md:h-11" })}>
        Abrir ficha do cliente
      </Link>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-bold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function NotesEditor({ contactId, initial, canEdit }: { contactId: string; initial: string; canEdit: boolean }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const dirty = value.trim() !== initial.trim();

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await updateContactNotesAction(contactId, value);
      if (result) setError(result.error);
      else setSaved(true);
    });
  }

  return (
    <Section title="Notas">
      <label htmlFor={`notes-${contactId}`} className="sr-only">
        Notas sobre o cliente
      </label>
      <Textarea
        id={`notes-${contactId}`}
        rows={3}
        value={value}
        readOnly={!canEdit}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        placeholder={canEdit ? "Preferências, alergias, observações…" : "Sem notas."}
      />
      <div className="mt-1.5 flex items-center justify-end gap-2" aria-live="polite">
        {error ? <span className="text-[13px] font-semibold text-err">{error}</span> : null}
        {saved && !dirty ? <span className="text-[13px] text-ok">Notas salvas</span> : null}
        {dirty && canEdit ? (
          <Button size="sm" variant="primary" onClick={save} disabled={pending}>
            Salvar notas
          </Button>
        ) : null}
      </div>
    </Section>
  );
}
