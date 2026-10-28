import type { Account, ChangePasswordInput, NotificationPrefs, TwoFactorSetup, UpdateProfileInput } from "@duckzap/contracts/settings";
import { schema, withOrg } from "@duckzap/db";
import { and, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Deps } from "../../lib/context";
import type { Actor } from "../team/http";
import { upsertProfile } from "../team/queries";
import { errRes, okRes, type Res } from "../team/result";

/** Minha conta: só precisa de sessão. Cookies novos do Better Auth (sessão trocada) voltam em `setCookies`. */
type Ctx = { deps: Deps; actor: Actor; headers: Headers };
export type WithCookies<T> = { value: T; setCookies: string[] };

const requiresTwoFactor = (role: Actor["role"]) => role === "owner" || role === "admin";

export async function getAccount({ deps, actor }: Omit<Ctx, "headers">): Promise<Account> {
  const org = actor.organizationId;
  const [user] = await deps.db
    .select({ name: schema.user.name, email: schema.user.email, twoFactorEnabled: schema.user.twoFactorEnabled })
    .from(schema.user)
    .where(eq(schema.user.id, actor.userId));
  const [profile] = await withOrg(deps.db, org, (tx) =>
    tx
      .select()
      .from(schema.memberProfiles)
      .where(and(eq(schema.memberProfiles.organizationId, org), eq(schema.memberProfiles.userId, actor.userId))),
  );
  const enabled = Boolean(user?.twoFactorEnabled);
  return {
    name: user?.name ?? actor.name,
    email: user?.email ?? actor.email,
    phone: profile?.phone ?? "",
    twoFactor: { enabled, enabledAt: enabled ? (profile?.twoFactorEnabledAt?.toISOString() ?? null) : null },
    twoFactorRequired: requiresTwoFactor(actor.role),
    notifications: profile?.notifications ?? { sound: true, browser: true, emailSummary: false },
  };
}

export async function updateProfile({ deps, actor }: Omit<Ctx, "headers">, input: UpdateProfileInput): Promise<Res<null>> {
  const email = input.email.trim().toLowerCase();
  const [taken] = await deps.db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(sql`lower(${schema.user.email}) = ${email} and ${schema.user.id} <> ${actor.userId}`)
    .limit(1);
  if (taken) return errRes(409, "email_taken", "Este e-mail já tem conta. Use outro.");
  const changedEmail = email !== actor.email.toLowerCase();
  await deps.db
    .update(schema.user)
    .set({ name: input.name, email, ...(changedEmail ? { emailVerified: false } : {}) })
    .where(eq(schema.user.id, actor.userId));
  await withOrg(deps.db, actor.organizationId, (tx) =>
    upsertProfile(tx, actor.organizationId, actor.userId, uuidv7(), { phone: input.phone.trim() || null }),
  );
  return okRes(null);
}

export async function updateNotifications({ deps, actor }: Omit<Ctx, "headers">, prefs: NotificationPrefs): Promise<Res<null>> {
  await withOrg(deps.db, actor.organizationId, (tx) =>
    upsertProfile(tx, actor.organizationId, actor.userId, uuidv7(), { notifications: prefs }),
  );
  return okRes(null);
}

type AuthError = { code?: string; message?: string };
async function authError(response: Response): Promise<AuthError> {
  return ((await response.json().catch(() => null)) as AuthError | null) ?? {};
}

export async function changePassword({ deps, headers }: Ctx, input: ChangePasswordInput): Promise<Res<WithCookies<null>>> {
  if (input.currentPassword === input.newPassword) return errRes(409, "same_password", "A nova senha precisa ser diferente da atual.");
  const response = await deps.auth.api.changePassword({
    headers,
    body: { currentPassword: input.currentPassword, newPassword: input.newPassword, revokeOtherSessions: true },
    asResponse: true,
  });
  if (!response.ok) {
    const error = await authError(response);
    if (response.status === 400 && error.code === "INVALID_PASSWORD") return errRes(409, "wrong_password", "A senha atual não confere.");
    if (error.code === "PASSWORD_TOO_SHORT" || error.code === "PASSWORD_TOO_LONG") return errRes(422, "validation_error", "Use uma senha entre 8 e 128 caracteres.");
    return errRes(409, "wrong_password", "A senha atual não confere.");
  }
  return okRes({ value: null, setCookies: response.headers.getSetCookie() });
}

/** Passo 1 do 2FA: gera o segredo (ainda não vale até confirmar o código). Exige a senha (Better Auth). */
export async function startTwoFactorSetup({ deps, headers }: Ctx, password: string): Promise<Res<WithCookies<TwoFactorSetup>>> {
  const response = await deps.auth.api.enableTwoFactor({ headers, body: { password }, asResponse: true });
  if (!response.ok) {
    const error = await authError(response);
    if (error.code === "INVALID_PASSWORD") return errRes(409, "wrong_password", "A senha não confere.");
    if (error.code === "TOTP_ALREADY_ENABLED") return errRes(409, "already_enabled", "A verificação em duas etapas já está ativa.");
    return errRes(409, "setup_failed", "Não foi possível iniciar a configuração. Tente de novo.");
  }
  const body = (await response.json()) as { totpURI?: string };
  if (!body.totpURI) return errRes(409, "setup_failed", "Não foi possível iniciar a configuração. Tente de novo.");
  const secret = new URL(body.totpURI).searchParams.get("secret") ?? "";
  return okRes({ value: { secret, otpauthUrl: body.totpURI }, setCookies: response.headers.getSetCookie() });
}

/** Passo 2: confere o código do app e liga o 2FA. Devolve os códigos de recuperação (mostrados uma vez). */
export async function confirmTwoFactor({ deps, actor, headers }: Ctx, code: string): Promise<Res<WithCookies<{ recoveryCodes: string[] }>>> {
  const response = await deps.auth.api.verifyTOTP({ headers, body: { code }, asResponse: true });
  if (!response.ok) {
    const error = await authError(response);
    if (error.code === "TOTP_NOT_ENABLED") return errRes(409, "no_setup", "Comece a configuração de novo.");
    return errRes(409, "invalid_code", "Código incorreto. Confira o app e tente de novo.");
  }
  const { backupCodes } = await deps.auth.api.viewBackupCodes({ body: { userId: actor.userId } });
  await withOrg(deps.db, actor.organizationId, (tx) =>
    upsertProfile(tx, actor.organizationId, actor.userId, uuidv7(), { twoFactorEnabledAt: new Date() }),
  );
  return okRes({ value: { recoveryCodes: backupCodes }, setCookies: response.headers.getSetCookie() });
}

export async function disableTwoFactor({ deps, actor, headers }: Ctx, password: string): Promise<Res<WithCookies<null>>> {
  if (requiresTwoFactor(actor.role)) {
    return errRes(409, "required", "A verificação em duas etapas é obrigatória para Proprietário e Administrador.");
  }
  const response = await deps.auth.api.disableTwoFactor({ headers, body: { password }, asResponse: true });
  if (!response.ok) return errRes(409, "wrong_password", "A senha não confere.");
  await withOrg(deps.db, actor.organizationId, (tx) =>
    upsertProfile(tx, actor.organizationId, actor.userId, uuidv7(), { twoFactorEnabledAt: null }),
  );
  return okRes({ value: null, setCookies: response.headers.getSetCookie() });
}
