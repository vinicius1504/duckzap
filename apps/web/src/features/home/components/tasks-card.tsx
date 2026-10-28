"use client";

import type { HomeOverview, TaskPriority } from "@duckzap/contracts/home";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { Chip, type ChipTone } from "@duckzap/ui/components/chip";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { createTaskAction, setTaskDoneAction } from "../actions";

const priority: Record<TaskPriority, { label: string; tone: ChipTone }> = {
  urgent: { label: "Urgente", tone: "err" },
  high: { label: "Alta", tone: "warn" },
  medium: { label: "Média", tone: "info" },
  low: { label: "Baixa", tone: "neutral" },
};

type Task = HomeOverview["tasks"][number];

export function TasksCard({ tasks }: { tasks: Task[] }) {
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [optimistic, update] = useOptimistic(tasks, (state, change: { id: string; done: boolean }) =>
    state.map((t) => (t.id === change.id ? { ...t, done: change.done } : t)),
  );
  const open = optimistic.filter((t) => !t.done).length;

  function toggle(task: Task) {
    startTransition(async () => {
      update({ id: task.id, done: !task.done });
      await setTaskDoneAction(task.id, !task.done);
    });
  }

  async function add(formData: FormData) {
    const result = await createTaskAction(String(formData.get("title") ?? ""));
    if (result) setError(result.error);
    else {
      setError(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <CardTitle>Minhas tarefas</CardTitle>
        <span className="text-[13px] text-ink-2">{open} abertas</span>
      </div>
      <form action={add} className="mb-1.5 mt-3.5 flex gap-2">
        <label htmlFor="nova-tarefa" className="sr-only">
          Nova tarefa
        </label>
        <input
          ref={inputRef}
          id="nova-tarefa"
          name="title"
          placeholder="Nova tarefa rápida…"
          aria-describedby={error ? "nova-tarefa-erro" : undefined}
          className="h-10 min-w-0 flex-1 rounded-control border border-field bg-surface px-3"
        />
        <button type="submit" aria-label="Adicionar tarefa" className={buttonVariants({ variant: "primary", size: "icon" })}>
          <Icon name="plus" size={18} strokeWidth={2.2} />
        </button>
      </form>
      {error ? (
        <p id="nova-tarefa-erro" className="text-[13px] font-semibold text-err">
          {error}
        </p>
      ) : null}
      <ul>
        {optimistic.map((task) => (
          <li key={task.id} className={cn("flex gap-3 border-t border-line py-3", task.done && "opacity-70")}>
            <input
              type="checkbox"
              checked={task.done}
              onChange={() => toggle(task)}
              aria-label={`${task.done ? "Reabrir" : "Concluir"}: ${task.title}`}
              className="mt-0.5 size-5 accent-ink"
            />
            <div className="flex-1">
              <p className={cn("font-semibold", task.done && "line-through")}>{task.title}</p>
              <p className="mt-0.5 text-[13px] text-ink-2">
                {task.dueLabel} · {task.assignee}
              </p>
            </div>
            <Chip tone={priority[task.priority].tone}>{priority[task.priority].label}</Chip>
          </li>
        ))}
      </ul>
    </Card>
  );
}
