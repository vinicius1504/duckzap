"use client";

import type { ConversationDetail, InboxLookups, Message } from "@duckzap/contracts/conversations";
import { Avatar } from "@duckzap/ui/components/avatar";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogContent } from "@duckzap/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@duckzap/ui/components/dropdown-menu";
import { Alert } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import Link from "next/link";
import { useTyping } from "@/lib/realtime/use-typing";
import { useEffect, useOptimistic, useState, useTransition } from "react";
import {
  assumeConversationAction,
  markConversationReadAction,
  reopenConversationAction,
  resendMessageAction,
  resolveConversationAction,
  sendMessageAction,
} from "../actions";
import { inboxHref } from "../search-params";
import { AppointmentDialog } from "./appointment-dialog";
import { Composer } from "./composer";
import { CustomerPanel } from "./customer-panel";
import { MessageThread } from "./message-thread";
import { ModeControls } from "./mode-bar";
import { TransferDialog } from "./transfer-dialog";
import { CHANNEL_KIND_LABEL, displayName, memberName, NO_PERMISSION_HINT, type InboxPermissions } from "./view-model";

type Props = {
  detail: ConversationDetail;
  lookups: InboxLookups;
  permissions: InboxPermissions;
  viewer: { id: string; name: string };
  sendingPausedReason: string | null;
  query: string;
  nowIso: string;
  timeZone: string;
};

type ThreadChange = { type: "add"; message: Message } | { type: "status"; id: string; status: Message["status"] };

export function ConversationView({ detail, lookups, permissions, viewer, sendingPausedReason, query, nowIso, timeZone }: Props) {
  const { conversation, contact } = detail;
  const [messages, applyChange] = useOptimistic(detail.messages, (state, change: ThreadChange) =>
    change.type === "add"
      ? [...state, change.message]
      : state.map((m) => (m.id === change.id ? { ...m, status: change.status, failureReason: null } : m)),
  );
  const [, startTransition] = useTransition();
  const [busy, startAction] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const typing = useTyping(conversation.id);

  const channel = lookups.channels.find((c) => c.id === conversation.channelId);
  const stage = lookups.tags.find((t) => t.id === conversation.stageId);
  const agentName = lookups.agents.find((a) => a.id === conversation.agentId)?.name ?? "Agente Duck";
  const followUpAgent = lookups.agents.find((a) => a.id === conversation.followUp?.agentId)?.name ?? null;
  const assignee = memberName(lookups, conversation.assigneeId);
  const resolved = conversation.status === "resolved";
  // quem atende de verdade: com pessoa respondendo (human_active) o modo "IA" não vale, mesmo em conversas antigas gravadas assim
  const effectiveMode = conversation.mode === "ai" && conversation.status === "human_active" ? "human" : conversation.mode;
  const name = displayName(conversation.contact);
  const canAssume = permissions.assign && !resolved && conversation.assigneeId !== viewer.id;
  const replyReason = !permissions.reply ? NO_PERMISSION_HINT : sendingPausedReason;

  // abrir a conversa zera as não lidas
  useEffect(() => {
    if (conversation.unreadCount > 0 && permissions.reply) void markConversationReadAction(conversation.id);
  }, [conversation.id, conversation.unreadCount, permissions.reply]);

  function act(action: () => Promise<{ error: string } | null>) {
    setError(null);
    startAction(async () => {
      const result = await action();
      if (result) setError(result.error);
    });
  }

  async function send(draft: Parameters<Parameters<typeof Composer>[0]["onSend"]>[0]): Promise<string | null> {
    const clientId = `tmp_${Date.now().toString(36)}`;
    const optimistic: Message = {
      id: clientId,
      conversationId: conversation.id,
      kind: draft.kind,
      direction: draft.kind === "note" ? "internal" : "out",
      author: { kind: "member", id: viewer.id, name: viewer.name },
      body: draft.body,
      attachment: draft.attachment,
      status: draft.kind === "note" ? null : "sending",
      failureReason: null,
      createdAt: new Date().toISOString(),
    };
    return new Promise((resolve) => {
      startTransition(async () => {
        applyChange({ type: "add", message: optimistic });
        const result = await sendMessageAction({ ...draft, conversationId: conversation.id, clientId });
        resolve("error" in result ? result.error : null);
      });
    });
  }

  function resend(message: Message) {
    setError(null);
    startTransition(async () => {
      applyChange({ type: "status", id: message.id, status: "sending" });
      const result = await resendMessageAction(conversation.id, message.id);
      if (result) setError(result.error);
    });
  }

  const panel = (
    <CustomerPanel
      conversation={conversation}
      contact={contact}
      lookups={lookups}
      canEdit={permissions.editContact}
      canSchedule={permissions.manageAppointments}
      onSchedule={() => {
        setPanelOpen(false);
        setScheduleOpen(true);
      }}
      nowIso={nowIso}
      timeZone={timeZone}
    />
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section aria-label={`Conversa com ${name}`} className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
        <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-3 max-md:gap-2 max-md:px-2 max-md:py-2">
          <Link
            href={inboxHref(query, { conversation: null })}
            aria-label="Voltar para a lista"
            className="flex size-11 items-center justify-center rounded-control hover:bg-surface-hover md:hidden"
          >
            <Icon name="arrowLeft" />
          </Link>
          <div className="flex min-w-0 flex-[1_1_160px] items-center gap-3">
            <Avatar name={contact.name} />
            <span className="min-w-0">
              <h2 className="truncate text-base font-bold">{name}</h2>
              <p className="truncate text-[13px] text-ink-2">
                {typing.contact || typing.agent ? (
                  // ocupa o lugar da linha de detalhes: sem deslocar nada na tela
                  <span className="font-semibold text-ink">{typing.contact ? "digitando…" : `${agentName} digitando…`}</span>
                ) : (
                  <>
                    {channel ? `${CHANNEL_KIND_LABEL[channel.kind]} · ${channel.name}` : "Canal"}
                    {stage ? ` · Etapa: ${stage.name}` : ""}
                    {assignee ? ` · ${assignee}` : ""}
                  </>
                )}
              </p>
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 max-sm:w-full">
            <ModeControls
              conversationId={conversation.id}
              mode={conversation.mode}
              agentName={agentName}
              followUp={conversation.followUp}
              followUpAgentName={followUpAgent}
              canChangeMode={permissions.assign}
              canFollowUp={permissions.reply}
              resolved={resolved}
              nowIso={nowIso}
              timeZone={timeZone}
            />
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button size="icon" className="size-9 max-md:size-11" aria-label="Mais ações">
                  <Icon name="dots" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {canAssume ? (
                  <DropdownMenuItem disabled={busy} onSelect={() => act(() => assumeConversationAction(conversation.id))}>
                    <Icon name="user" size={18} />
                    Assumir conversa
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={!permissions.transfer || resolved}
                  title={permissions.transfer ? undefined : NO_PERMISSION_HINT}
                  onSelect={() => setTransferOpen(true)}
                >
                  <Icon name="users" size={18} />
                  Transferir
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!permissions.manageAppointments || resolved}
                  title={permissions.manageAppointments ? undefined : NO_PERMISSION_HINT}
                  onSelect={() => setScheduleOpen(true)}
                >
                  <Icon name="calendar" size={18} />
                  Agendar horário
                </DropdownMenuItem>
                <DropdownMenuItem className="xl:hidden" onSelect={() => setPanelOpen(true)}>
                  <Icon name="user" size={18} />
                  Dados do cliente
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {resolved ? (
                  <DropdownMenuItem disabled={busy || !permissions.reply} onSelect={() => act(() => reopenConversationAction(conversation.id))}>
                    <Icon name="refresh" size={18} />
                    Reabrir
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem disabled={busy || !permissions.reply} onSelect={() => act(() => resolveConversationAction(conversation.id))}>
                    <Icon name="check" size={18} />
                    Resolver
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {error ? (
          <Alert tone="err" live className="m-3 mb-0">
            {error}
          </Alert>
        ) : null}
        {channel?.status === "disconnected" ? (
          <Alert
            tone="warn"
            className="m-3 mb-0"
            title={`${channel.name} desconectado.`}
            action={
              <Link href="/canais" className="font-bold underline">
                Reconectar agora
              </Link>
            }
          >
            As mensagens não saem até reconectar.
          </Alert>
        ) : null}

        <MessageThread
          messages={messages}
          nowIso={nowIso}
          timeZone={timeZone}
          onResend={resend}
          resendDisabledReason={replyReason}
        />

        {resolved ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-line bg-surface px-5 py-4 max-md:px-3">
            <Icon name="check" className="text-ok" />
            <p className="flex-1 text-ink-2">
              Conversa resolvida{conversation.resolvedBy === "ai" ? ` pelo ${agentName}` : ""}. Se o cliente escrever de novo, ela volta para a fila.
            </p>
            <Button size="sm" disabled={busy || !permissions.reply} onClick={() => act(() => reopenConversationAction(conversation.id))}>
              Reabrir conversa
            </Button>
          </div>
        ) : (
          <Composer
            key={conversation.id}
            conversationId={conversation.id}
            mode={conversation.mode}
            agentName={agentName}
            quickReplies={lookups.quickReplies}
            sendingPausedReason={replyReason}
            onSend={send}
          />
        )}
      </section>

      <aside
        aria-label="Dados do cliente"
        className="relative hidden w-80 shrink-0 overflow-y-auto border-l border-line bg-surface p-5 xl:block"
      >
        {panel}
      </aside>

      <Dialog open={panelOpen} onOpenChange={setPanelOpen}>
        <DialogContent title="Dados do cliente" side="right" className="xl:hidden">
          {panel}
        </DialogContent>
      </Dialog>

      <TransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        conversationId={conversation.id}
        contactName={contact.name}
        lookups={lookups}
        currentAssigneeId={conversation.assigneeId}
        viewerId={viewer.id}
      />
      <AppointmentDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        conversationId={conversation.id}
        contactName={contact.name}
        lookups={lookups}
        nowIso={nowIso}
        timeZone={timeZone}
      />
    </div>
  );
}
