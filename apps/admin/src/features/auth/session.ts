import "server-only";
import type { AdminSession } from "@duckzap/contracts/admin";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { ADMIN_SESSION_COOKIE } from "@/lib/api-server";
import { getChallenge, getCurrentSession } from "./api";

export { ADMIN_SESSION_COOKIE };
/** Desafio de 2FA entre a senha e o código (curto, 5 min). */
export const ADMIN_CHALLENGE_COOKIE = "dz_admin_2fa";

/** Sessão do pedido atual (memorizada por render). A validação é na API (tabela de sessões); o cookie sozinho não vale nada. */
export const getAdminSession = cache(async (): Promise<AdminSession | null> => {
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;
  return getCurrentSession();
});

export async function requireAdminSession(): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) redirect("/entrar");
  return session;
}

/** Desafio de 2FA pendente (recarregar a página no passo do código não volta para a senha). */
export async function getPendingChallenge() {
  const token = (await cookies()).get(ADMIN_CHALLENGE_COOKIE)?.value;
  return token ? getChallenge(token) : null;
}
