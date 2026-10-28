import "server-only";
import type { Session } from "@duckzap/contracts/session";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getCurrentSession } from "./api";

/** Sessão do pedido atual (memorizada por render). Vem da API (`/v1/me`). */
export const getSession = cache(async (): Promise<Session | null> => getCurrentSession());

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/entrar");
  return session;
}
