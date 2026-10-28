import "server-only";
import { can, type Permission } from "@duckzap/contracts/permissions";
import type { Session } from "@duckzap/contracts/session";
import { redirect } from "next/navigation";
import { requireSession } from "./session";

/** Para páginas: sem permissão, vai para a tela "Sem acesso". */
export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await requireSession();
  if (!can(session.user.role, permission)) redirect("/sem-acesso");
  return session;
}

/** Para Server Actions: devolve erro em vez de redirecionar. */
export async function authorize(permission: Permission): Promise<{ session: Session } | { error: string }> {
  const session = await requireSession();
  if (!can(session.user.role, permission)) {
    return { error: "Você não tem permissão para fazer isso. Fale com um administrador." };
  }
  return { session };
}
