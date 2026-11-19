import "server-only";
import type { Session } from "@duckzap/contracts/session";
import { redirect } from "next/navigation";
import { cache } from "react";
import { lookupSession, type SessionLookup } from "./api";

/** `/v1/me` do pedido atual (memorizado por render). */
const getSessionLookup = cache(async (): Promise<SessionLookup> => lookupSession());

/** Sessão do pedido atual (memorizada por render). Vem da API (`/v1/me`). `null` = deslogado ou conta sem empresa. */
export const getSession = cache(async (): Promise<Session | null> => {
  const lookup = await getSessionLookup();
  return lookup.kind === "ok" ? lookup.session : null;
});

/** Exige sessão com empresa. Logado SEM empresa (criou a conta e parou) volta ao cadastro, não ao login. */
export async function requireSession(): Promise<Session> {
  const lookup = await getSessionLookup();
  if (lookup.kind === "no_organization") redirect("/comecar");
  if (lookup.kind !== "ok") redirect("/entrar");
  return lookup.session;
}
