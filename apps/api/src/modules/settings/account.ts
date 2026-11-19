import type {
  Account,
  ChangePasswordInput,
  NotificationPrefs,
  RecoveryCodes,
  TwoFactorEmailSetup,
  TwoFactorMethod,
  TwoFactorSetup,
  UpdateProfileInput,
} from "@duckzap/contracts/settings";
import type { MemberRole } from "@duckzap/contracts/session";
import { schema, withOrg, type Database } from "@duckzap/db";
import { and, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Deps } from "../../lib/context";
import { roleRequiresTwoFactor } from "../../middleware/two-factor";
import type { Actor } from "../team/http";
import { upsertProfile } from "../team/queries";
import { errRes, okRes, type Res } from "../team/result";

/** Minha conta: só precisa de sessão. Cookies novos do Better Auth (sessão trocada) voltam em `setCookies`. */
type Ctx = { deps: Deps; actor: Actor; headers: Headers };
export type WithCookies<T> = { value: T; setCookies: string[] };

/**
 * 2FA: só a SESSÃO (sem exigir empresa), porque também é configurado no cadastro, antes de a empresa existir.
 * `membership` = empresa ativa (null no cadastro): só serve para a data "ativa desde" e para a opção que exige 2FA.
 */
export type TwoFactorCtx = {
  deps: Deps;
  userId: string;
  email: string;
  membership: { organizationId: string; role: MemberRole } | null;
  headers: Headers;
};

/**
 * Método do 2FA, DERIVADO do banco (sem coluna própria):
 *   desativada → `user.two_factor_enabled = false`;
 *   app        → ativa e a linha de two_factor com `verified = true` (o app autenticador foi conferido);
 *   e-mail     → ativa e sem app conferido (`verified = false`: a linha só guarda os códigos de recuperação).
 * O Better Auth já se guia por isso no login: só oferece "totp" com `verified = true`.
 */
export async function loadTwoFactorStatus(db: Database, userId: string): Promise<{ enabled: boolean; method: TwoFactorMethod | null }> {
  const [row] = await db
    .select({ enabled: schema.user.twoFactorEnabled, verified: schema.twoFactor.verified })
    .from(schema.user)
    .leftJoin(schema.twoFactor, eq(schema.twoFactor.userId, schema.user.id))
    .where(eq(schema.user.id, userId))
    .limit(1);
  const enabled = Boolean(row?.enabled);
  return { enabled, method: enabled ? (row?.verified === true ? "app" : "email") : null };
}

export async function getAccount({ deps, actor }: Omit<Ctx, "headers">): Promise<Account> {
  const org = actor.organizationId;
  const [user] = await deps.db
    .select({ name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, actor.userId));
  const [profile] = await withOrg(deps.db, org, (tx) =>
    tx
      .select()
      .from(schema.memberProfiles)
      .where(and(eq(schema.memberProfiles.organizationId, org), eq(schema.memberProfiles.userId, actor.userId))),
  );
  const { enabled, method } = await loadTwoFactorStatus(deps.db, actor.userId);
  return {
    name: user?.name ?? actor.name,
    email: user?.email ?? actor.email,
    phone: profile?.phone ?? "",
    twoFactor: { enabled, enabledAt: enabled ? (profile?.twoFactorEnabledAt?.toISOString() ?? null) : null, method },
    twoFactorRequired: roleRequiresTwoFactor(actor.role),
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

// ---------- Verificação em duas etapas (só sessão; também usada no cadastro) ----------

const cookiesOf = (...responses: Response[]) => responses.flatMap((r) => r.headers.getSetCookie());

/** "Ativa desde" fica no perfil da empresa ativa; no cadastro (sem empresa ainda) não há onde guardar e fica sem data. */
async function recordEnabledAt({ deps, userId, membership }: TwoFactorCtx, at: Date | null) {
  if (!membership) return;
  await withOrg(deps.db, membership.organizationId, (tx) =>
    upsertProfile(tx, membership.organizationId, userId, uuidv7(), { twoFactorEnabledAt: at }),
  );
}

/**
 * App autenticador, passo 1: gera o segredo (ainda não vale até confirmar o código). Exige a senha (Better Auth).
 * Quem usa o código por e-mail pode trocar para o app por aqui: os códigos de recuperação são trocados por novos.
 */
export async function startTwoFactorSetup(ctx: TwoFactorCtx, password: string): Promise<Res<WithCookies<TwoFactorSetup>>> {
  const { deps, userId, headers } = ctx;
  const status = await loadTwoFactorStatus(deps.db, userId);
  if (status.method === "app") return errRes(409, "already_enabled", "O app autenticador já está ativo.");
  const response = await deps.auth.api.enableTwoFactor({ headers, body: { password, method: "totp" }, asResponse: true });
  if (!response.ok) {
    const error = await authError(response);
    if (error.code === "INVALID_PASSWORD") return errRes(409, "wrong_password", "A senha não confere.");
    if (error.code === "TOTP_ALREADY_ENABLED") return errRes(409, "already_enabled", "O app autenticador já está ativo.");
    return errRes(409, "setup_failed", "Não foi possível iniciar a configuração. Tente de novo.");
  }
  const body = (await response.json()) as { totpURI?: string };
  if (!body.totpURI) return errRes(409, "setup_failed", "Não foi possível iniciar a configuração. Tente de novo.");
  const secret = new URL(body.totpURI).searchParams.get("secret") ?? "";
  return okRes({ value: { secret, otpauthUrl: body.totpURI }, setCookies: cookiesOf(response) });
}

/** App autenticador, passo 2: confere o código do app e liga o 2FA. Devolve os códigos de recuperação (mostrados uma vez). */
export async function confirmTwoFactor(ctx: TwoFactorCtx, code: string): Promise<Res<WithCookies<{ recoveryCodes: string[] }>>> {
  const { deps, userId, headers } = ctx;
  const before = await loadTwoFactorStatus(deps.db, userId);
  if (before.method === "app") return errRes(409, "already_enabled", "O app autenticador já está ativo.");
  const response = await deps.auth.api.verifyTOTP({ headers, body: { code }, asResponse: true });
  if (!response.ok) {
    const error = await authError(response);
    if (error.code === "TOTP_NOT_ENABLED") return errRes(409, "no_setup", "Comece a configuração de novo.");
    return errRes(409, "invalid_code", "Código incorreto. Confira o app e tente de novo.");
  }
  const { backupCodes } = await deps.auth.api.viewBackupCodes({ body: { userId } });
  if (!before.enabled) await recordEnabledAt(ctx, new Date());
  return okRes({ value: { recoveryCodes: backupCodes }, setCookies: cookiesOf(response) });
}

/**
 * Código por e-mail, passo 1: confere a senha e manda o código para o e-mail da conta (o envio tem limite por pessoa,
 * ver lib/two-factor-email.ts). Para quem ainda não tem 2FA, prepara a linha de two_factor SEM app conferido
 * (`verified = false`) só para gerar os códigos de recuperação; o 2FA só liga ao confirmar o código (passo 2).
 */
export async function startEmailTwoFactor(ctx: TwoFactorCtx, password: string): Promise<Res<WithCookies<TwoFactorEmailSetup>>> {
  const { deps, userId, email, headers } = ctx;
  const status = await loadTwoFactorStatus(deps.db, userId);
  if (status.method === "email") return errRes(409, "already_enabled", "O código por e-mail já está ativo.");
  const checked = await deps.auth.api.verifyPassword({ headers, body: { password }, asResponse: true });
  if (!checked.ok) return errRes(409, "wrong_password", "A senha não confere.");
  const responses = [checked];
  if (!status.enabled) {
    // o segredo de app gerado aqui nunca sai do servidor e não vale no login (verified = false)
    const prepared = await deps.auth.api.enableTwoFactor({ headers, body: { password, method: "totp" }, asResponse: true });
    if (!prepared.ok) return errRes(409, "setup_failed", "Não foi possível iniciar a configuração. Tente de novo.");
    await prepared.body?.cancel();
    responses.push(prepared);
  }
  const sent = await deps.auth.api.sendTwoFactorOTP({ headers, body: {}, asResponse: true });
  if (sent.status === 429) {
    const error = await authError(sent);
    return errRes(429, "rate_limited", error.message ?? "Aguarde alguns segundos para pedir outro código.");
  }
  if (!sent.ok) return errRes(409, "send_failed", "Não conseguimos enviar o código agora. Tente de novo.");
  return okRes({ value: { email }, setCookies: cookiesOf(...responses, sent) });
}

/**
 * Código por e-mail, passo 2: confere o código e liga o 2FA (o Better Auth troca a sessão: cookies novos em `setCookies`).
 * Quem vinha do app autenticador troca de método: o app deixa de valer (`verified = false`) e os códigos de recuperação
 * continuam os mesmos (`recoveryCodes: null`).
 */
export async function confirmEmailTwoFactor(ctx: TwoFactorCtx, code: string): Promise<Res<WithCookies<RecoveryCodes>>> {
  const { deps, userId, headers } = ctx;
  const before = await loadTwoFactorStatus(deps.db, userId);
  if (before.method === "email") return errRes(409, "already_enabled", "O código por e-mail já está ativo.");
  const response = await deps.auth.api.verifyTwoFactorOTP({ headers, body: { code }, asResponse: true });
  if (!response.ok) {
    const error = await authError(response);
    if (error.code === "OTP_HAS_EXPIRED") return errRes(409, "expired", "O código venceu. Peça um novo.");
    if (error.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") return errRes(409, "expired", "Muitas tentativas com este código. Peça um novo.");
    return errRes(409, "invalid_code", "Código incorreto. Confira o e-mail e tente de novo.");
  }
  let recoveryCodes: string[] | null = null;
  if (before.method === "app") {
    await deps.db.update(schema.twoFactor).set({ verified: false }).where(eq(schema.twoFactor.userId, userId));
  } else {
    recoveryCodes = (await deps.auth.api.viewBackupCodes({ body: { userId } })).backupCodes;
    await recordEnabledAt(ctx, new Date());
  }
  return okRes({ value: { recoveryCodes }, setCookies: cookiesOf(response) });
}

/** Novos códigos de recuperação (os antigos deixam de valer). Exige a senha. Vale para os dois métodos. */
export async function regenerateRecoveryCodes(
  { deps, userId, headers }: TwoFactorCtx,
  password: string,
): Promise<Res<WithCookies<{ recoveryCodes: string[] }>>> {
  const status = await loadTwoFactorStatus(deps.db, userId);
  if (!status.enabled) return errRes(409, "not_enabled", "Ative a verificação em duas etapas primeiro.");
  const response = await deps.auth.api.generateBackupCodes({ headers, body: { password }, asResponse: true });
  if (!response.ok) {
    const error = await authError(response);
    if (error.code === "INVALID_PASSWORD") return errRes(409, "wrong_password", "A senha não confere.");
    return errRes(409, "not_enabled", "Não foi possível gerar novos códigos. Tente de novo.");
  }
  const body = (await response.json()) as { backupCodes?: string[] };
  return okRes({ value: { recoveryCodes: body.backupCodes ?? [] }, setCookies: cookiesOf(response) });
}

/** Desliga o 2FA (os dois métodos). Só é recusado se a opção REQUIRE_2FA_FOR_ADMINS estiver ligada e o papel exigir. */
export async function disableTwoFactor(ctx: TwoFactorCtx, password: string): Promise<Res<WithCookies<null>>> {
  if (roleRequiresTwoFactor(ctx.membership?.role ?? null)) {
    return errRes(
      409,
      "required",
      "Sua empresa exige a verificação em duas etapas para Proprietário e Administrador. Você pode trocar de método, mas não desativar.",
    );
  }
  const response = await ctx.deps.auth.api.disableTwoFactor({ headers: ctx.headers, body: { password }, asResponse: true });
  if (!response.ok) return errRes(409, "wrong_password", "A senha não confere.");
  await recordEnabledAt(ctx, null);
  return okRes({ value: null, setCookies: cookiesOf(response) });
}

