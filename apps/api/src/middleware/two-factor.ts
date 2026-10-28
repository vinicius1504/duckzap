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

/** Regra pura (§5.1): só Proprietário e Administrador precisam; Atendente não é afetado. */
export function needsTwoFactor(input: { role: MemberRole; twoFactorEnabled: boolean; required: boolean }) {
  return input.required && !input.twoFactorEnabled && (input.role === "owner" || input.role === "admin");
}

export const isTwoFactorEnabled = (auth: AuthSession) => Boolean((auth.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled);

function toRole(role: string): MemberRole {
  return role === "owner" || role === "admin" ? role : "agent";
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
  const memberships = await db
    .select({ role: schema.member.role, organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, auth.user.id));
  const active = memberships.find((m) => m.organizationId === auth.session.activeOrganizationId) ?? memberships[0];
  if (!active) return false;
  return needsTwoFactor({ role: toRole(active.role), twoFactorEnabled: false, required });
}
