"use client";

import type { ConversationSummary, InboxLookups } from "@duckzap/contracts/conversations";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Chip } from "@duckzap/ui/components/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@duckzap/ui/components/dropdown-menu";
import { Alert, EmptyState } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import Link from "next/link";
import { useOptimistic, useState, useTransition, type ReactNode } from "react";
import { moveConversationStageAction } from "../actions";
import { inboxHref } from "../search-params";
import { displayName, NO_PERMISSION_HINT, previewText, relativeAgo, stagesOf, statusChip } from "./view-model";

type Props = {
  items: ConversationSummary[];
  lookups: InboxLookups;
  canMove: boolean;
  query: string;
  nowIso: string;
  timeZone: string;
};

/**
 * Quadro por etapa do funil. Arrastar pela alça (mouse/toque) ou usar "Mover para…"
 * (teclado e leitor de tela).
 */
export function KanbanBoard({ items, lookups, canMove, query, nowIso, timeZone }: Props) {
  const stages = stagesOf(lookups);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [board, move] = useOptimistic(items, (state, change: { id: string; stageId: string }) =>
    state.map((c) => (c.id === change.id ? { ...c, stageId: change.stageId } : c)),
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const nameOf = (id: string) => {
    const c = board.find((x) => x.id === id);
    return c ? displayName(c.contact) : "Conversa";
  };
  const stageName = (id: string) => stages.find((s) => s.id === id)?.name ?? "";

  function moveTo(id: string, stageId: string) {
    const current = board.find((c) => c.id === id);
    if (!current || current.stageId === stageId || !canMove) return;
    setError(null);
    startTransition(async () => {
      move({ id, stageId });
      const result = await moveConversationStageAction(id, stageId);
      if (result) setError(result.error);
      else setAnnouncement(`${nameOf(id)} movida para ${stageName(stageId)}.`);
    });
  }

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    if (event.over) moveTo(String(event.active.id), String(event.over.id));
  }

  const active = activeId ? board.find((c) => c.id === activeId) : undefined;

  if (items.length === 0) {
    return (
      <div className="flex-1 p-6">
        <EmptyState icon="columns" title="Nenhuma conversa no quadro" description="Ajuste os filtros ou volte para a lista." />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {error ? (
        <Alert tone="err" live className="mx-6 mt-4 max-md:mx-4">
          {error}
        </Alert>
      ) : null}
      {!canMove ? (
        <Alert tone="info" className="mx-6 mt-4 max-md:mx-4">
          Você pode ver o quadro, mas mover entre etapas depende do seu papel.
        </Alert>
      ) : null}
      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
        accessibility={{
          screenReaderInstructions: {
            draggable: "Para mover pelo teclado, use o botão Mover para… do cartão.",
          },
          announcements: {
            onDragStart: ({ active: a }) => `Movendo ${nameOf(String(a.id))}.`,
            onDragOver: ({ over }) => (over ? `Sobre a etapa ${stageName(String(over.id))}.` : "Fora das etapas."),
            onDragEnd: ({ active: a, over }) =>
              over ? `${nameOf(String(a.id))} solta em ${stageName(String(over.id))}.` : "Movimento cancelado.",
            onDragCancel: () => "Movimento cancelado.",
          },
        }}
      >
        <div className="relative flex min-h-0 flex-1 items-start gap-4 overflow-x-auto px-6 py-5 max-md:px-4">
          {stages.map((stage) => {
            const cards = board.filter((c) => c.stageId === stage.id);
            return (
              <Column key={stage.id} id={stage.id} title={stage.name} count={cards.length}>
                {cards.length === 0 ? (
                  <p className="rounded-card border border-dashed border-field p-4 text-center text-[13px] text-ink-2">
                    Nada nesta etapa. Arraste um cartão para cá.
                  </p>
                ) : (
                  cards.map((c) => (
                    <Card
                      key={c.id}
                      conversation={c}
                      lookups={lookups}
                      stages={stages}
                      canMove={canMove}
                      onMove={(stageId) => moveTo(c.id, stageId)}
                      href={inboxHref(query, { view: "lista", conversation: c.id })}
                      nowIso={nowIso}
                      timeZone={timeZone}
                      dimmed={c.id === activeId}
                    />
                  ))
                )}
              </Column>
            );
          })}
        </div>
        <DragOverlay>
          {active ? (
            <div className="w-[300px] rotate-2 rounded-card border border-duck bg-surface p-3 shadow-xl">
              <strong>{displayName(active.contact)}</strong>
              <p className="truncate text-[13px] text-ink-2">{previewText(active.lastMessage)}</p>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function Column({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${title}, ${count} conversas`}
      className={cn(
        "flex w-[300px] shrink-0 flex-col rounded-card p-1.5 transition-colors max-md:w-[min(300px,calc(100vw-48px))]",
        isOver && "bg-duck/15",
      )}
    >
      <div className="mb-2.5 flex items-center justify-between px-1">
        <h2 className="text-sm font-bold">{title}</h2>
        <Chip>{count}</Chip>
      </div>
      <ul className="flex flex-col gap-2.5">{children}</ul>
    </section>
  );
}

function Card({
  conversation: c,
  lookups,
  stages,
  canMove,
  onMove,
  href,
  nowIso,
  timeZone,
  dimmed,
}: {
  conversation: ConversationSummary;
  lookups: InboxLookups;
  stages: ReturnType<typeof stagesOf>;
  canMove: boolean;
  onMove: (stageId: string) => void;
  href: string;
  nowIso: string;
  timeZone: string;
  dimmed: boolean;
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: c.id, disabled: !canMove });
  const chip = statusChip(c, lookups);
  const name = displayName(c.contact);
  const isWaiting = c.status === "handoff_requested";

  return (
    <li
      ref={setNodeRef}
      className={cn(
        "relative rounded-card border border-line bg-surface p-3",
        isWaiting && "border-duck",
        dimmed && "opacity-40",
      )}
    >
      <div className="flex items-start gap-1">
        <Link href={href} className="min-w-0 flex-1 rounded-control">
          <strong className="block truncate">{name}</strong>
          <span className="block truncate text-[13px] text-ink-2">{previewText(c.lastMessage)}</span>
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={!canMove}
              title={canMove ? undefined : NO_PERMISSION_HINT}
              aria-label={`Mover ${name} para…`}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-hover disabled:opacity-50 max-md:size-11"
            >
              <Icon name="dots" size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Mover para…</DropdownMenuLabel>
            {stages.map((s) => (
              <DropdownMenuItem key={s.id} disabled={s.id === c.stageId} onSelect={() => onMove(s.id)}>
                {s.id === c.stageId ? <Icon name="check" size={16} /> : <span className="size-4" aria-hidden="true" />}
                {s.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {canMove ? (
          <button
            type="button"
            {...listeners}
            {...attributes}
            tabIndex={-1}
            aria-hidden="true"
            className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-ink-2 hover:bg-surface-hover active:cursor-grabbing max-md:size-11"
          >
            <GripIcon />
          </button>
        ) : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Chip tone={chip.tone}>{chip.label}</Chip>
        <span className="text-xs text-ink-2">
          {relativeAgo(isWaiting && c.waitingSince ? c.waitingSince : c.lastMessage.at, nowIso, timeZone)}
        </span>
      </div>
    </li>
  );
}

function GripIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {[6, 12, 18].map((y) => (
        <g key={y}>
          <circle cx="9" cy={y} r="1.6" />
          <circle cx="15" cy={y} r="1.6" />
        </g>
      ))}
    </svg>
  );
}
