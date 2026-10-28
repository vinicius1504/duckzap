"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/features/auth/session";
import { createTask, setTaskDone } from "./api";

// Server Actions finas: sessão → validação → api.ts → revalidar. Nenhuma regra de negócio aqui.

export async function createTaskAction(title: string) {
  await requireSession();
  const parsed = z.string().trim().min(1).max(200).safeParse(title);
  if (!parsed.success) return { error: "Escreva a tarefa antes de adicionar." };
  const result = await createTask(parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath("/inicio");
  return null;
}

export async function setTaskDoneAction(id: string, done: boolean) {
  await requireSession();
  await setTaskDone(z.string().parse(id), z.boolean().parse(done));
  revalidatePath("/inicio");
}
