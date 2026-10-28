import { createHash, randomBytes } from "node:crypto";
import { schema, type Database } from "@duckzap/db";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { verifyPassword, hashPassword } from "better-auth/crypto";
import { v7 as uuidv7 } from "uuid";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { activationRequired, verifyActivationCode } from "./activation";
import { writeAudit } from "./audit";
import { RateLimiter, MAX_CODE_ATTEMPTS, isLocked, nextFailureState } from "./rate-limit";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp";

const { platformAdmins, adminSessions, adminChallenges } = schema;

export const ADMIN_COOKIE = "dz_admin";
/** Sessão curta: 8 h absolutas, sem renovação ("manter conectado" não existe no painel). */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ISSUER = "DuckChat Admin";

export type AdminPrincipal = { id: string; name: string; email: string; sessionId: string; expiresAt: Date };

export type AuthContext = { ip: string | null; userAgent: string | null };

export type Limiters = { signInIp: RateLimiter; signInAccount: RateLimiter; verifyIp: RateLimiter };

export function createLimiters(): Limiters {
  const windowMs = 15 * 60 * 1000;
  return {
    signInIp: new RateLimiter({ max: 20, windowMs }),
    signInAccount: new RateLimiter({ max: 10, windowMs }),
    verifyIp: new RateLimiter({ max: 30, windowMs }),
  };
}

const GENERIC_CREDENTIALS = "E-mail ou senha incorretos. Confira e tente de novo.";
const RATE_LIMITED = "Muitas tentativas. Aguarde alguns minutos e tente de novo.";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const secretLabel = (adminId: string) => `platform_admin:${adminId}`;

// hash de uma senha qualquer: usado quando o e-mail não existe, para o tempo de resposta não revelar a conta
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));

export type SignInResult =
  | { ok: true; challengeToken: string; expiresAt: string; needsEnrollment: boolean }
  | { ok: false; code: "invalid_credentials" | "rate_limited" | "activation_required"; message: string };

/** 1º passo: e-mail e senha. Nunca devolve sessão: devolve um desafio de 2FA (e, no 1º login, a chave TOTP a cadastrar). */
export async function startSignIn(
  db: Database,
  limiters: Limiters,
  input: { email: string; password: string; activationCode?: string | undefined },
  ctx: AuthContext,
  now = new Date(),
  options: { requireActivation?: boolean } = {},
): Promise<SignInResult> {
  const email = input.email.trim().toLowerCase().slice(0, 200);
  if (!limiters.signInIp.hit(ctx.ip ?? "unknown").allowed || !limiters.signInAccount.hit(email).allowed) {
    return { ok: false, code: "rate_limited", message: RATE_LIMITED };
  }

  const [admin] = await db
    .select()
    .from(platformAdmins)
    .where(sql`lower(${platformAdmins.email}) = ${email}`)
    .limit(1);

  // sempre roda a verificação (com hash falso se a conta não existe): tempo igual para conta existente ou não
  const valid = await verifyPassword({ hash: admin?.passwordHash ?? (await getDummyHash()), password: input.password });
  const locked = admin ? isLocked(admin.lockedUntil, now) : false;
  const usable = Boolean(admin?.active) && !locked;

  if (!admin || !usable || !valid) {
    await db.transaction(async (tx) => {
      if (admin && usable && !valid) {
        await tx.update(platformAdmins).set({ ...nextFailureState(admin.failedAttempts, now), updatedAt: now }).where(eq(platformAdmins.id, admin.id));
      }
      await writeAudit(tx, {
        kind: "auth",
        actor: { id: admin?.id ?? null, name: admin?.name ?? "(conta desconhecida)", email },
        action: "admin.sign_in_failed",
        target: { type: "admin", id: admin?.id ?? "-", name: email },
        reason: locked ? "conta bloqueada temporariamente" : "senha incorreta ou conta inexistente",
        ip: ctx.ip,
      });
    });
    return { ok: false, code: "invalid_credentials", message: GENERIC_CREDENTIALS };
  }

  const needsEnrollment = !admin.totpSecretEnc;
  // 1º acesso: cadastrar o 2FA exige o código de ativação gerado no servidor (senha sozinha não basta)
  if (needsEnrollment && (options.requireActivation ?? activationRequired()) && !verifyActivationCode(admin.id, input.activationCode)) {
    await db.transaction(async (tx) => {
      if (input.activationCode) {
        await tx.update(platformAdmins).set({ ...nextFailureState(admin.failedAttempts, now), updatedAt: now }).where(eq(platformAdmins.id, admin.id));
      }
      await writeAudit(tx, {
        kind: "auth",
        actor: admin,
        action: "admin.sign_in_failed",
        target: { type: "admin", id: admin.id, name: admin.email },
        reason: input.activationCode ? "código de ativação incorreto" : "código de ativação ausente",
        ip: ctx.ip,
      });
    });
    return {
      ok: false,
      code: "activation_required",
      message: "Primeiro acesso: informe o código de ativação que a equipe de infraestrutura gerou para você.",
    };
  }
  const pending = needsEnrollment ? generateTotpSecret() : null;
  const token = newToken();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  await db.transaction(async (tx) => {
    // um desafio por vez por conta; limpa também restos antigos
    await tx.delete(adminChallenges).where(eq(adminChallenges.adminId, admin.id));
    await tx.delete(adminChallenges).where(lt(adminChallenges.expiresAt, new Date(now.getTime() - 24 * 3600_000)));
    await tx.delete(adminSessions).where(lt(adminSessions.expiresAt, new Date(now.getTime() - 7 * 24 * 3600_000)));
    await tx.insert(adminChallenges).values({
      id: uuidv7(),
      adminId: admin.id,
      tokenHash: hashToken(token),
      pendingTotpSecretEnc: pending ? encryptSecret(secretLabel(admin.id), pending) : null,
      ip: ctx.ip,
      expiresAt,
    });
  });
  return { ok: true, challengeToken: token, expiresAt: expiresAt.toISOString(), needsEnrollment };
}

export type ChallengeInfo = {
  email: string;
  /** só no 1º login: chave para cadastrar no app autenticador */
  enrollment: { secret: string; otpauthUri: string } | null;
};

/** Desafio ainda válido (para retomar o passo do código sem pedir a senha de novo). */
export async function getChallenge(db: Database, token: string, now = new Date()): Promise<ChallengeInfo | null> {
  const [row] = await db
    .select({
      adminId: adminChallenges.adminId,
      pending: adminChallenges.pendingTotpSecretEnc,
      attempts: adminChallenges.attempts,
      email: platformAdmins.email,
    })
    .from(adminChallenges)
    .innerJoin(platformAdmins, eq(platformAdmins.id, adminChallenges.adminId))
    .where(
      and(
        eq(adminChallenges.tokenHash, hashToken(token)),
        isNull(adminChallenges.consumedAt),
        gt(adminChallenges.expiresAt, now),
        lt(adminChallenges.attempts, MAX_CODE_ATTEMPTS),
      ),
    )
    .limit(1);
  if (!row) return null;
  const enrollment = row.pending
    ? (() => {
        const secret = decryptSecret(secretLabel(row.adminId), row.pending);
        return { secret, otpauthUri: otpauthUri({ secret, account: row.email, issuer: ISSUER }) };
      })()
    : null;
  return { email: row.email, enrollment };
}

export type VerifyResult =
  | { ok: true; sessionToken: string; expiresAt: string; admin: { id: string; name: string; email: string } }
  | { ok: false; code: "invalid_code" | "expired" | "too_many_attempts" | "rate_limited"; message: string };

const EXPIRED = "O tempo para digitar o código acabou. Entre de novo.";

/** 2º passo: código do app autenticador. Máx. 5 códigos errados por desafio; depois, recomeçar. */
export async function verifyTwoFactor(
  db: Database,
  limiters: Limiters,
  input: { challengeToken: string; code: string },
  ctx: AuthContext,
  nowDate = new Date(),
): Promise<VerifyResult> {
  if (!limiters.verifyIp.hit(ctx.ip ?? "unknown").allowed) return { ok: false, code: "rate_limited", message: RATE_LIMITED };

  // incremento atômico: tentativas paralelas não furam o limite de 5
  const [challenge] = await db
    .update(adminChallenges)
    .set({ attempts: sql`${adminChallenges.attempts} + 1` })
    .where(
      and(
        eq(adminChallenges.tokenHash, hashToken(input.challengeToken)),
        isNull(adminChallenges.consumedAt),
        gt(adminChallenges.expiresAt, nowDate),
        lt(adminChallenges.attempts, MAX_CODE_ATTEMPTS),
      ),
    )
    .returning();
  if (!challenge) return { ok: false, code: "expired", message: EXPIRED };

  const [admin] = await db.select().from(platformAdmins).where(eq(platformAdmins.id, challenge.adminId)).limit(1);
  if (!admin || !admin.active || isLocked(admin.lockedUntil, nowDate)) return { ok: false, code: "expired", message: EXPIRED };

  const enrolling = !admin.totpSecretEnc;
  const encrypted = admin.totpSecretEnc ?? challenge.pendingTotpSecretEnc;
  if (!encrypted) return { ok: false, code: "expired", message: EXPIRED };
  const step = verifyTotp({
    secret: decryptSecret(secretLabel(admin.id), encrypted),
    code: input.code,
    nowMs: nowDate.getTime(),
    minStep: enrolling ? null : admin.totpLastStep,
  });

  if (step === null) {
    const exhausted = challenge.attempts >= MAX_CODE_ATTEMPTS;
    await db.transaction(async (tx) => {
      if (exhausted) {
        await tx.update(adminChallenges).set({ consumedAt: nowDate }).where(eq(adminChallenges.id, challenge.id));
        await tx.update(platformAdmins).set({ ...nextFailureState(admin.failedAttempts, nowDate), updatedAt: nowDate }).where(eq(platformAdmins.id, admin.id));
      }
      await writeAudit(tx, {
        kind: "auth",
        actor: admin,
        action: "admin.two_factor_failed",
        target: { type: "admin", id: admin.id, name: admin.email },
        reason: exhausted ? "código 2FA incorreto (limite de tentativas)" : "código 2FA incorreto",
        ip: ctx.ip,
      });
    });
    return exhausted
      ? { ok: false, code: "too_many_attempts", message: "Muitas tentativas. Entre de novo com e-mail e senha." }
      : { ok: false, code: "invalid_code", message: "Código incorreto. Confira no app autenticador e tente de novo." };
  }

  const sessionToken = newToken();
  const expiresAt = new Date(nowDate.getTime() + SESSION_TTL_MS);
  const consumed = await db.transaction(async (tx) => {
    const [used] = await tx
      .update(adminChallenges)
      .set({ consumedAt: nowDate })
      .where(and(eq(adminChallenges.id, challenge.id), isNull(adminChallenges.consumedAt)))
      .returning({ id: adminChallenges.id });
    if (!used) return false;
    await tx
      .update(platformAdmins)
      .set({
        ...(enrolling ? { totpSecretEnc: challenge.pendingTotpSecretEnc, totpEnabledAt: nowDate } : {}),
        totpLastStep: step,
        failedAttempts: 0,
        lockedUntil: null,
        lastLoginAt: nowDate,
        updatedAt: nowDate,
      })
      .where(eq(platformAdmins.id, admin.id));
    await tx.insert(adminSessions).values({
      id: uuidv7(),
      adminId: admin.id,
      tokenHash: hashToken(sessionToken),
      ip: ctx.ip,
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    });
    await writeAudit(tx, {
      kind: "auth",
      actor: admin,
      action: enrolling ? "admin.two_factor_enrolled" : "admin.sign_in",
      target: { type: "admin", id: admin.id, name: admin.email },
      reason: enrolling ? "2FA configurado e login" : "login",
      ip: ctx.ip,
    });
    return true;
  });
  if (!consumed) return { ok: false, code: "expired", message: EXPIRED };

  return { ok: true, sessionToken, expiresAt: expiresAt.toISOString(), admin: { id: admin.id, name: admin.name, email: admin.email } };
}

/** Resolve o cookie `dz_admin` em uma sessão válida (não revogada, não expirada, admin ativo). */
export async function getAdminSession(db: Database, token: string, now = new Date()): Promise<AdminPrincipal | null> {
  const [row] = await db
    .select({
      sessionId: adminSessions.id,
      expiresAt: adminSessions.expiresAt,
      id: platformAdmins.id,
      name: platformAdmins.name,
      email: platformAdmins.email,
    })
    .from(adminSessions)
    .innerJoin(platformAdmins, eq(platformAdmins.id, adminSessions.adminId))
    .where(
      and(
        eq(adminSessions.tokenHash, hashToken(token)),
        isNull(adminSessions.revokedAt),
        gt(adminSessions.expiresAt, now),
        eq(platformAdmins.active, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Logout: revoga a sessão no banco (o cookie sozinho não vale mais nada) e audita. */
export async function signOut(db: Database, admin: AdminPrincipal, ctx: AuthContext, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(adminSessions).set({ revokedAt: now }).where(and(eq(adminSessions.id, admin.sessionId), isNull(adminSessions.revokedAt)));
    await writeAudit(tx, {
      kind: "auth",
      actor: admin,
      action: "admin.sign_out",
      target: { type: "admin", id: admin.id, name: admin.email },
      reason: "logout",
      ip: ctx.ip,
    });
  });
}
