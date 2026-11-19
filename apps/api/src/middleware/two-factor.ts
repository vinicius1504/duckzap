import type { MemberRole } from "@duckzap/contracts/session";
import { schema, type Database } from "@duckzap/db";
import { eq } from "drizzle-orm";
import type { AuthSession } from "../lib/context";
import { loadSecurityConfig } from "./security-config";

/** Resposta padrão quando falta o 2FA (o front leva a pessoa para a tela de configurar). */
export const TWO_FACTOR_REQUIRED = {
  error: { code: "two_factor_required", message: "Ative a verificação em duas etapas para continuar usando o sistema." },
} as const;

/** Rotas que continuam abertas sem 2FA: a sessão (`/me`), o cadastro da empresa e a conta (onde se configura o 2FA). */
const EXEMPT_PATH = /^\/v1\/(me|onboarding|account)(\/|$)/;
export const isTwoFactorExemptPath = (path: string) => EXEMPT_PATH.test(path);

/** Regra pura (§5.1): com a opção ligada, só Proprietário e Administrador precisam; Atendente não é afetado. */
export function needsTwoFactor(input: { role: MemberRole; twoFactorEnabled: boolean; required: boolean }) {
  return input.required && !input.twoFactorEnabled && (input.role === "owner" || input.role === "admin");
}

export const isTwoFactorEnabled = (auth: AuthSession) => Boolean((auth.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled);

function toRole(role: string): MemberRole {
  return role === "owner" || role === "admin" ? role : "agent";
}

/** O papel exige 2FA SE a opção `REQUIRE_2FA_FOR_ADMINS` estiver ligada (padrão: desligada; o 2FA é recomendado). */
export const roleRequiresTwoFactor = (role: MemberRole | null, required = loadSecurityConfig().require2faForAdmins) =>
  required && (role === "owner" || role === "admin");

/** Empresa ativa da sessão (igual a `buildSession`), senão a primeira; null = conta ainda sem empresa (cadastro). */
export async function activeMembership(
  db: Database,
  auth: Pick<AuthSession, "user" | "session">,
): Promise<{ organizationId: string; role: MemberRole } | null> {
  const memberships = await db
    .select({ role: schema.member.role, organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, auth.user.id));
  const active = memberships.find((m) => m.organizationId === auth.session.activeOrganizationId) ?? memberships[0];
  return active ? { organizationId: active.organizationId, role: toRole(active.role) } : null;
}

/**
 * true quando a sessão pertence a quem PRECISA de 2FA e ainda não tem. Só consulta o banco para quem não tem 2FA
 * (a empresa ativa da sessão, igual a `buildSession`); quem já ativou não paga a consulta.
 */
export async function mustSetUpTwoFactor(
  db: Database,
  auth: AuthSession,
  required = loadSecurityConfig().require2faForAdmins,
): Promise<boolean> {
  if (!required || isTwoFactorEnabled(auth)) return false;
  const active = await activeMembership(db, auth);
  if (!active) return false;
  return needsTwoFactor({ role: active.role, twoFactorEnabled: false, required });
}
