"use client";

import type { AppointmentStatus } from "@duckzap/contracts/appointments";
import { inviteIneligibility, type ContactDetail, type InviteOverview, type Tag } from "@duckzap/contracts/contacts";
import { Avatar } from "@duckzap/ui/components/avatar";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert, EmptyState } from "@duckzap/ui/components/feedback";
import { Textarea } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@duckzap/ui/components/tabs";
import { cn } from "@duckzap/ui/cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { statusView } from "@/features/appointments/labels";
import { OpenConversationButton } from "@/features/conversations/components/open-conversation-button";
import { formatDate, formatPhone } from "@/lib/format";
import { addNoteAction } from "../actions";
import { consentMethodLabel, eventIcon, ineligibleLabel, originLabel } from "../labels";
import { NO_PERMISSION_HINT, type ContactPerms } from "../perms";
import { ConsentChip, TagChips } from "./badges";
import { ContactFormDialog } from "./contact-form-dialog";
import { InviteDialog } from "./invite-dialog";

export type ProfileAppointment = {
  id: string;
  startsAt: string;
  typeName: string;
  durationMinutes: number;
  ownerName: string;
  status: AppointmentStatus;
};

const dateTime: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" };

/** Ficha do cliente: resumo, histórico, notas e agendamentos. Usada na gaveta e na página. */
export function ContactProfile({
  contact,
  tags,
  owners,
  appointments,
  inviteOverview,
  perms,
  sendingPaused,
  timeZone,
  variant,
}: {
  contact: ContactDetail;
  tags: Tag[];
  owners: { id: string; name: string }[];
  appointments: ProfileAppointment[];
  inviteOverview: InviteOverview;
  perms: ContactPerms;
  sendingPaused: boolean;
  timeZone: string;
  variant: "drawer" | "page";
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  const now = Date.now();
  const upcoming = appointments
    .filter((a) => Date.parse(a.startsAt) >= now && a.status !== "canceled" && a.status !== "done")
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const past = appointments.filter((a) => !upcoming.includes(a)).sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  const ineligible = inviteIneligibility(contact);
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions = dateTime) => formatDate(iso, opts, timeZone);

  function addNote(formData: FormData) {
    const text = String(formData.get("note") ?? "");
    startTransition(async () => {
      const result = await addNoteAction(contact.id, text);
      if ("error" in result) return setNoteError(result.error);
      setNoteError(null);
      formRef.current?.reset();
      router.refresh();
    });
  }

  const contactLine = contact.phone ? formatPhone(contact.phone) : contact.instagram ? `@${contact.instagram}` : "Sem telefone";

  return (
    <div className="flex flex-col gap-4">
      {variant === "page" ? (
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={contact.name} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">{contact.name}</h1>
            <p className="text-ink-2">{contactLine}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Avatar name={contact.name} size="lg" />
          <p className="text-ink-2">{contactLine}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <OpenConversationButton contactId={contact.id} variant="primary" className="flex-1 max-md:h-11" />
        <Link href={`/agenda?novo=1&cliente=${contact.id}`} className={buttonVariants({ className: "max-md:h-11" })}>
          <Icon name="calendar" size={16} />
          Agendar
        </Link>
        <Button onClick={() => setEditOpen(true)} disabled={!perms.edit} title={perms.edit ? undefined : NO_PERMISSION_HINT} className="max-md:h-11">
          <Icon name="edit" size={16} />
          Editar
        </Button>
      </div>

      <Tabs defaultValue="resumo">
        <TabsList aria-label="Seções da ficha">
          <TabsTrigger value="resumo">Resumo</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
          <TabsTrigger value="notas">Notas ({contact.notes.length})</TabsTrigger>
          <TabsTrigger value="agenda">Agendamentos</TabsTrigger>
        </TabsList>

        <TabsContent value="resumo" className="flex flex-col gap-4 pt-4">
          <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-3 gap-y-2 text-[13px]">
            <dt className="text-ink-2">Telefone</dt>
            <dd>{contact.phone ? formatPhone(contact.phone) : "—"}</dd>
            <dt className="text-ink-2">E-mail</dt>
            <dd className="break-all">{contact.email ?? "—"}</dd>
            <dt className="text-ink-2">Instagram</dt>
            <dd>{contact.instagram ? `@${contact.instagram}` : "—"}</dd>
            <dt className="text-ink-2">É cliente</dt>
            <dd>{contact.isCustomer ? "Sim" : "Não"}</dd>
            <dt className="text-ink-2">Responsável</dt>
            <dd>{contact.ownerName ?? "Ninguém"}</dd>
            <dt className="text-ink-2">Origem</dt>
            <dd>
              {contact.origin ? originLabel[contact.origin] : <span className="font-semibold text-err">Sem origem</span>}
              {contact.originNote ? <span className="block text-ink-2">{contact.originNote}</span> : null}
            </dd>
            <dt className="text-ink-2">Nascimento</dt>
            <dd>{contact.birthDate ? fmt(contact.birthDate, { day: "2-digit", month: "2-digit", year: "numeric" }) : "—"}</dd>
            <dt className="text-ink-2">Criado em</dt>
            <dd>{fmt(contact.createdAt, { day: "2-digit", month: "2-digit", year: "numeric" })}</dd>
            <dt className="text-ink-2">Etiquetas</dt>
            <dd>
              <TagChips tagIds={contact.tagIds} tags={tags} max={6} />
            </dd>
          </dl>

          <section aria-labelledby="consent-title" className="flex flex-col gap-2 rounded-control border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="consent-title" className="text-[13px] font-bold">
                Disparos (opt-in)
              </h3>
              <ConsentChip consent={contact.consent} long />
            </div>
            {contact.consent ? (
              <>
                <p className="text-[13px] text-ink-2">
                  {consentMethodLabel[contact.consent.method]}
                  {contact.consent.channelName ? ` · ${contact.consent.channelName}` : ""} · atualizado em {fmt(contact.consent.updatedAt)}
                </p>
                {contact.consent.inviteText ? (
                  <figure className="text-[13px]">
                    <figcaption className="font-semibold">
                      Mensagem enviada{contact.consent.inviteSentAt ? ` em ${fmt(contact.consent.inviteSentAt)}` : ""}
                    </figcaption>
                    <blockquote className="mt-1 rounded-lg bg-surface-2 p-2">{contact.consent.inviteText}</blockquote>
                  </figure>
                ) : null}
                {contact.consent.replyText ? (
                  <figure className="text-[13px]">
                    <figcaption className="font-semibold">
                      Resposta{contact.consent.repliedAt ? ` em ${fmt(contact.consent.repliedAt)}` : ""}
                    </figcaption>
                    <blockquote className="mt-1 rounded-lg bg-surface-2 p-2">“{contact.consent.replyText}”</blockquote>
                  </figure>
                ) : contact.consent.status === "pending" ? (
                  <p className="text-[13px] text-ink-2">Sem resposta ainda. Se não responder em 7 dias, o convite expira.</p>
                ) : null}
              </>
            ) : ineligible ? (
              <p className="text-[13px] text-ink-2">Não pode receber o convite: {ineligibleLabel[ineligible]}.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <p className="flex-[1_1_200px] text-[13px] text-ink-2">Nunca foi convidado. O convite é enviado uma vez só.</p>
                {perms.invite ? (
                  <Button size="sm" onClick={() => setInviteOpen(true)} disabled={sendingPaused}>
                    Convidar
                  </Button>
                ) : null}
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-1.5 text-[13px] font-bold">Próximos agendamentos</h3>
            {upcoming.length ? (
              <ul className="flex flex-col gap-2">
                {upcoming.slice(0, 2).map((a) => (
                  <AppointmentRow key={a.id} appointment={a} fmt={fmt} />
                ))}
              </ul>
            ) : (
              <p className="text-ink-2">Nenhum agendamento futuro.</p>
            )}
          </section>

          {contact.notes[0] ? (
            <section>
              <h3 className="mb-1.5 text-[13px] font-bold">Última nota</h3>
              <p className="text-ink-2">{contact.notes[0].text}</p>
            </section>
          ) : null}
        </TabsContent>

        <TabsContent value="historico" className="pt-4">
          {contact.history.length ? (
            <ol className="flex flex-col">
              {contact.history.map((event) => (
                <li key={event.id} className="flex gap-3 border-b border-line py-3 last:border-0">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-2">
                    <Icon name={eventIcon[event.kind]} size={16} />
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold">{event.title}</p>
                    {event.detail ? <p className="text-ink-2">{event.detail}</p> : null}
                    <p className="text-xs text-ink-2">{fmt(event.at)}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState icon="history" title="Sem histórico ainda" description="Conversas, agendamentos e campanhas aparecem aqui." />
          )}
        </TabsContent>

        <TabsContent value="notas" className="flex flex-col gap-3 pt-4">
          {perms.edit ? (
            <form ref={formRef} action={addNote} className="flex flex-col gap-2">
              <label htmlFor={`nota-${contact.id}`} className="text-[13px] font-semibold">
                Nova nota interna
              </label>
              <Textarea
                id={`nota-${contact.id}`}
                name="note"
                rows={3}
                placeholder="Só a equipe vê. Ex.: prefere horários de manhã."
                invalid={Boolean(noteError)}
                aria-describedby={noteError ? `nota-erro-${contact.id}` : undefined}
              />
              {noteError ? (
                <p id={`nota-erro-${contact.id}`} className="text-[13px] font-semibold text-err">
                  {noteError}
                </p>
              ) : null}
              <Button type="submit" variant="primary" disabled={pending} className="self-end">
                {pending ? "Salvando…" : "Salvar nota"}
              </Button>
            </form>
          ) : null}
          {contact.notes.length ? (
            <ul className="flex flex-col gap-2">
              {contact.notes.map((note) => (
                <li key={note.id} className="rounded-control border border-line p-3">
                  <p>{note.text}</p>
                  <p className="mt-1 text-xs text-ink-2">
                    {note.authorName} · {fmt(note.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-2">Nenhuma nota ainda.</p>
          )}
        </TabsContent>

        <TabsContent value="agenda" className="flex flex-col gap-4 pt-4">
          {appointments.length === 0 ? (
            <EmptyState
              icon="calendar"
              title="Nenhum agendamento"
              action={
                <Link href={`/agenda?novo=1&cliente=${contact.id}`} className={buttonVariants({ variant: "primary" })}>
                  Agendar
                </Link>
              }
            />
          ) : (
            <>
              <section>
                <h3 className="mb-1.5 text-[13px] font-bold">Próximos</h3>
                {upcoming.length ? (
                  <ul className="flex flex-col gap-2">
                    {upcoming.map((a) => (
                      <AppointmentRow key={a.id} appointment={a} fmt={fmt} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-ink-2">Nenhum.</p>
                )}
              </section>
              {past.length ? (
                <section>
                  <h3 className="mb-1.5 text-[13px] font-bold">Anteriores</h3>
                  <ul className="flex flex-col gap-2">
                    {past.map((a) => (
                      <AppointmentRow key={a.id} appointment={a} fmt={fmt} />
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </TabsContent>
      </Tabs>

      {perms.edit ? <ContactFormDialog open={editOpen} onOpenChange={setEditOpen} contact={contact} tags={tags} owners={owners} /> : null}
      {perms.invite && !contact.consent && !ineligible ? (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          audience={{ eligibleIds: [contact.id], ineligible: {}, scope: "selection" }}
          overview={inviteOverview}
          sendingPaused={sendingPaused}
        />
      ) : null}
      {sendingPaused && variant === "page" ? <Alert tone="warn">Plano expirado: envio de convites pausado.</Alert> : null}
    </div>
  );
}

function AppointmentRow({ appointment: a, fmt }: { appointment: ProfileAppointment; fmt: (iso: string, o?: Intl.DateTimeFormatOptions) => string }) {
  const view = statusView[a.status];
  const when = fmt(a.startsAt, { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return (
    <li className={cn("flex flex-wrap items-center justify-between gap-2 rounded-control border border-line p-2.5", a.status === "canceled" && "opacity-70")}>
      <div>
        <strong className="capitalize">{when}</strong>
        <p className="text-[13px] text-ink-2">
          {a.typeName} · {a.durationMinutes} min · {a.ownerName}
        </p>
      </div>
      <Chip tone={view.tone}>{view.label}</Chip>
    </li>
  );
}
