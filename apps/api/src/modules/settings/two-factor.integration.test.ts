import { createHmac } from "node:crypto";
import { createFakeLlm } from "@duckzap/ai";
import { onboardingStateSchema } from "@duckzap/contracts/onboarding";
import { accountSchema } from "@duckzap/contracts/settings";
import { sessionSchema } from "@duckzap/contracts/session";
import { createDb, schema } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../auth";
import type { Env } from "../../env";
import type { AppBindings, Deps } from "../../lib/context";
import { requireAuth } from "../../middleware/require-auth";
import { onboardingRoutes } from "../onboarding/routes";
import { sessionRoutes } from "../session/routes";
import { settingsRoutes } from "./routes";

// INTEGRAÇÃO do 2FA OPCIONAL com o Better Auth REAL e o Postgres: sem obrigatoriedade nada bloqueia; a opção
// REQUIRE_2FA_FOR_ADMINS ligada mantém o comportamento antigo; ativar por app (TOTP) e por código no e-mail (OTP, com
// sendMail falso), login de cada método, troca de método, códigos de recuperação, "pular" durável no cadastro e isolamento.
// Só em banco descartável (nome diferente de "duckzap"), com DATABASE_URL (papel app) e DATABASE_ADMIN_URL (dono, limpa no fim).
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}

const url = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_ADMIN_URL;
const dbName = url ? new URL(url).pathname.slice(1) : "";
const allowed = Boolean(url && ownerUrl) && dbName !== "duckzap";

const app = createDb(url ?? "postgres://invalid/invalid", { max: 3 });
const owner = createDb(ownerUrl ?? "postgres://invalid/invalid", { max: 2 });
afterAll(async () => {
  await app.close();
  await owner.close();
});

const stamp = Date.now().toString(36);
const emails = {
  app: `tfa-app-${stamp}@teste.duckchat.local`,
  mail: `tfa-mail-${stamp}@teste.duckchat.local`,
  skip: `tfa-skip-${stamp}@teste.duckchat.local`,
  other: `tfa-other-${stamp}@teste.duckchat.local`,
};
const PASSWORD = "senha-bem-longa-123";

const env: Env = {
  NODE_ENV: "test",
  PORT: 4000,
  DATABASE_URL: url ?? "",
  PUBLIC_API_URL: "http://localhost:3000/api",
  WEB_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "x".repeat(32),
  SMTP_URL: "smtp://127.0.0.1:1",
  MAIL_FROM: "teste@duckchat.local",
  WEB_ORIGINS: ["http://localhost:3000"],
} as Env;

type Mail = { to: string; subject: string; text: string };
const sendMail = vi.fn(async (_message: Mail) => {});
// Os testes fazem vários logins seguidos: cada chamada vem de um "IP" diferente (x-forwarded-for, com TRUST_PROXY só aqui)
// para não cair no limite por IP do Better Auth, que não é o que se testa. Sem espera entre envios de e-mail aqui (o limite
// por pessoa tem um teste próprio, com outra instância).
function withTrustedProxy<T>(build: () => T): T {
  const saved = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "true";
  try {
    return build();
  } finally {
    if (saved === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = saved;
  }
}
const auth = withTrustedProxy(() =>
  createAuth({ env, db: app.db, sendMail, otpEmailLimit: { cooldownMs: 0, max: 1000, windowMs: 60_000 } }),
);
const deps: Deps = { env, db: app.db, auth, llm: createFakeLlm() };

const api = new OpenAPIHono<AppBindings>();
api.use("/v1/protegido/*", requireAuth(deps));
api.get("/v1/protegido/x", (c) => c.json({ ok: true }));
api.route("/v1", sessionRoutes(deps));
api.route("/v1", onboardingRoutes(deps));
api.route("/v1", settingsRoutes(deps));

/** Junta os Set-Cookie de uma resposta ao "pote" de cookies (o Better Auth troca a sessão ao ligar/desligar o 2FA). */
function merge(cookie: string, response: Response): string {
  const jar = new Map(
    cookie
      .split("; ")
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] as const),
  );
  for (const raw of response.headers.getSetCookie()) {
    const [pair = ""] = raw.split(";");
    const name = pair.slice(0, pair.indexOf("="));
    const value = pair.slice(pair.indexOf("=") + 1);
    if (!value || /max-age=0/i.test(raw)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

let ipSeq = 0;
const nextIp = () => `10.77.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
const authCall = (path: string, cookie = "", body: unknown = {}, handler = auth.handler) =>
  handler(
    new Request(`http://localhost:3000/api/v1/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-forwarded-for": nextIp(),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
const get = (path: string, cookie: string) => api.request(path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown = {}) =>
  api.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const errorCode = async (response: Response) => ((await response.json()) as { error?: { code?: string }; code?: string }).error?.code;

async function signUp(email: string) {
  const response = await authCall("/sign-up/email", "", { name: "Pessoa Teste", email, password: PASSWORD });
  expect(response.status).toBe(200);
  return { cookie: merge("", response), userId: ((await response.json()) as { user: { id: string } }).user.id };
}

const hours = (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => ({
  day,
  open: day !== "sun",
  opensAt: day !== "sun" ? "09:00" : "",
  closesAt: day !== "sun" ? "18:00" : "",
}));

/** TOTP (RFC 6238) a partir da chave base32 mostrada na tela, como o Google Authenticator calcula. */
function totp(secretBase32: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secretBase32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, "0");
}

/** Último código enviado por e-mail para `to` (o envio pode rodar em segundo plano). */
async function lastCodeTo(to: string, after: number) {
  let code = "";
  await vi.waitFor(() => {
    const mails = sendMail.mock.calls.map((c) => c[0]).filter((m) => m.to === to);
    expect(mails.length).toBeGreaterThan(after);
    code = /código de verificação é: (\d{6})/.exec(mails[mails.length - 1]!.text)?.[1] ?? "";
    expect(code).toMatch(/^\d{6}$/);
  });
  return code;
}
const mailsTo = (to: string) => sendMail.mock.calls.filter((c) => c[0].to === to).length;

async function account(cookie: string) {
  const response = await get("/v1/account", cookie);
  expect(response.status).toBe(200);
  return accountSchema.parse(await response.json());
}
async function onboarding(cookie: string) {
  const response = await get("/v1/onboarding", cookie);
  expect(response.status).toBe(200);
  return onboardingStateSchema.parse(await response.json());
}

/** Login com senha: devolve o cookie do desafio de 2FA e os métodos que o Better Auth oferece. */
async function signInChallenge(email: string, handler = auth.handler) {
  const response = await authCall("/sign-in/email", "", { email, password: PASSWORD }, handler);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] };
  expect(body.twoFactorRedirect).toBe(true);
  return { cookie: merge("", response), methods: body.twoFactorMethods ?? [] };
}

describe.skipIf(!allowed)("2FA opcional: app autenticador ou código por e-mail", () => {
  const orgIds: string[] = [];
  const users = {} as Record<keyof typeof emails, { cookie: string; userId: string }>;
  const savedRequire = process.env.REQUIRE_2FA_FOR_ADMINS;
  const savedNodeEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    delete process.env.REQUIRE_2FA_FOR_ADMINS;
    for (const key of Object.keys(emails) as (keyof typeof emails)[]) users[key] = await signUp(emails[key]);
    // "app" e "other" já têm empresa (Proprietários); "mail" e "skip" estão no cadastro, ainda sem empresa
    for (const key of ["app", "other"] as const) {
      const response = await post("/v1/onboarding/organization", users[key].cookie, { companyName: `Empresa ${key} ${stamp}`, businessHours: hours });
      expect(response.status).toBe(201);
      orgIds.push(((await response.json()) as { organizationId: string }).organizationId);
    }
  });

  afterEach(() => {
    if (savedRequire === undefined) delete process.env.REQUIRE_2FA_FOR_ADMINS;
    else process.env.REQUIRE_2FA_FOR_ADMINS = savedRequire;
    process.env.NODE_ENV = savedNodeEnv;
  });

  afterAll(async () => {
    if (orgIds.length) await owner.db.delete(schema.organization).where(inArray(schema.organization.id, orgIds));
    await owner.db.delete(schema.user).where(inArray(schema.user.email, Object.values(emails)));
  });

  it("sem obrigatoriedade (padrão, até em produção) nada bloqueia o Proprietário sem 2FA", async () => {
    delete process.env.REQUIRE_2FA_FOR_ADMINS;
    process.env.NODE_ENV = "production";
    const { cookie } = users.other;
    expect((await get("/v1/protegido/x", cookie)).status).toBe(200);
    const me = sessionSchema.parse(await (await get("/v1/me", cookie)).json());
    expect(me.user).toMatchObject({ role: "owner", twoFactorEnabled: false, twoFactorRequired: false });
    expect(await account(cookie)).toMatchObject({ twoFactorRequired: false, twoFactor: { enabled: false, method: null } });
  });

  it("com REQUIRE_2FA_FOR_ADMINS=true o comportamento antigo continua (bloqueia; dá para configurar; não desativa)", async () => {
    process.env.REQUIRE_2FA_FOR_ADMINS = "true";
    let cookie = users.other.cookie;
    const blocked = await get("/v1/protegido/x", cookie);
    expect(blocked.status).toBe(403);
    expect(await errorCode(blocked)).toBe("two_factor_required");
    expect(sessionSchema.parse(await (await get("/v1/me", cookie)).json()).user.twoFactorRequired).toBe(true);
    expect((await account(cookie)).twoFactorRequired).toBe(true);

    // a configuração continua aberta e libera o resto (aqui pelo e-mail)
    const setup = await post("/v1/account/two-factor/email/setup", cookie, { password: PASSWORD });
    expect(setup.status).toBe(200);
    const confirmed = await post("/v1/account/two-factor/email/confirm", cookie, { code: await lastCodeTo(emails.other, 0) });
    expect(confirmed.status).toBe(200);
    cookie = merge(cookie, confirmed);
    expect((await get("/v1/protegido/x", cookie)).status).toBe(200);

    const disabled = await post("/v1/account/two-factor/disable", cookie, { password: PASSWORD });
    expect(disabled.status).toBe(409);
    expect(await errorCode(disabled)).toBe("required");

    // desligada a opção, a mesma pessoa pode desativar
    delete process.env.REQUIRE_2FA_FOR_ADMINS;
    const off = await post("/v1/account/two-factor/disable", cookie, { password: PASSWORD });
    expect(off.status).toBe(200);
    users.other.cookie = merge(cookie, off);
    expect((await account(users.other.cookie)).twoFactor).toMatchObject({ enabled: false, method: null });
    const [row] = await owner.db.select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, users.other.userId));
    expect(row).toBeUndefined();
  });

  it("ativar pelo app: senha, QR/chave, código do app, códigos de recuperação; login pede o app (e-mail recusado)", async () => {
    let { cookie } = users.app;
    const wrong = await post("/v1/account/two-factor/setup", cookie, { password: "senha-errada-000" });
    expect(await errorCode(wrong)).toBe("wrong_password");

    const setup = await post("/v1/account/two-factor/setup", cookie, { password: PASSWORD });
    expect(setup.status).toBe(200);
    const { secret, otpauthUrl } = (await setup.json()) as { secret: string; otpauthUrl: string };
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    // ainda não vale: só liga ao conferir o código
    expect((await account(cookie)).twoFactor.enabled).toBe(false);

    expect(await errorCode(await post("/v1/account/two-factor/confirm", cookie, { code: "000000" }))).toBe("invalid_code");
    const confirmed = await post("/v1/account/two-factor/confirm", cookie, { code: totp(secret) });
    expect(confirmed.status).toBe(200);
    const { recoveryCodes } = (await confirmed.json()) as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    cookie = merge(cookie, confirmed);
    expect((await account(cookie)).twoFactor).toMatchObject({ enabled: true, method: "app" });
    expect(typeof (await account(cookie)).twoFactor.enabledAt).toBe("string");

    // login: o Better Auth oferece o app; pedir código por e-mail é recusado e nada é enviado
    const before = mailsTo(emails.app);
    const login = await signInChallenge(emails.app);
    expect(login.methods).toContain("totp");
    const otp = await authCall("/two-factor/send-otp", login.cookie);
    expect(otp.status).toBe(400);
    expect(((await otp.json()) as { code: string }).code).toBe("USE_AUTHENTICATOR_APP");
    expect(mailsTo(emails.app)).toBe(before);
    const verified = await authCall("/two-factor/verify-totp", login.cookie, { code: totp(secret) });
    expect(verified.status).toBe(200);
    expect((await get("/v1/protegido/x", merge(login.cookie, verified))).status).toBe(200);

    // código de recuperação também entra (uma vez)
    const again = await signInChallenge(emails.app);
    const byRecovery = await authCall("/two-factor/verify-backup-code", again.cookie, { code: recoveryCodes[0] });
    expect(byRecovery.status).toBe(200);
    users.app.cookie = cookie;
  });

  it("ativar por e-mail NO CADASTRO (sem empresa) e entrar recebendo o código por e-mail", async () => {
    let { cookie } = users.mail;
    expect((await onboarding(cookie)).security).toEqual({ twoFactorEnabled: false, method: null, skippedAt: null });

    expect(await errorCode(await post("/v1/account/two-factor/email/setup", cookie, { password: "senha-errada-000" }))).toBe("wrong_password");
    const setup = await post("/v1/account/two-factor/email/setup", cookie, { password: PASSWORD });
    expect(setup.status).toBe(200);
    expect(await setup.json()).toEqual({ email: emails.mail });
    const code = await lastCodeTo(emails.mail, 0);
    // o e-mail só tem o nome e o código: nada de senha, link ou dado da empresa
    const mail = sendMail.mock.calls.map((c) => c[0]).filter((m) => m.to === emails.mail).at(-1)!;
    expect(mail.subject).toMatch(/código de acesso/i);
    expect(mail.text).not.toContain(PASSWORD);
    expect(mail.text).not.toMatch(/https?:\/\//);
    // ainda não ligou (falta o código)
    expect((await onboarding(cookie)).security.twoFactorEnabled).toBe(false);

    const wrongCode = code === "000000" ? "111111" : "000000";
    expect(await errorCode(await post("/v1/account/two-factor/email/confirm", cookie, { code: wrongCode }))).toBe("invalid_code");
    const confirmed = await post("/v1/account/two-factor/email/confirm", cookie, { code });
    expect(confirmed.status).toBe(200);
    const { recoveryCodes } = (await confirmed.json()) as { recoveryCodes: string[] | null };
    expect(recoveryCodes).toHaveLength(10);
    cookie = merge(cookie, confirmed);
    // passo do cadastro feito com o 2FA ativo (sem precisar "pular")
    expect((await onboarding(cookie)).security).toEqual({ twoFactorEnabled: true, method: "email", skippedAt: null });
    const [row] = await owner.db.select({ verified: schema.twoFactor.verified }).from(schema.twoFactor).where(eq(schema.twoFactor.userId, users.mail.userId));
    expect(row?.verified).toBe(false);

    // login: só e-mail; o código chega por e-mail e abre a sessão
    const sent = mailsTo(emails.mail);
    const login = await signInChallenge(emails.mail);
    expect(login.methods).toEqual(["otp"]);
    // sem app conferido, o código de app nem é aceito
    expect((await authCall("/two-factor/verify-totp", login.cookie, { code: "123456" })).status).toBe(400);
    expect((await authCall("/two-factor/send-otp", login.cookie)).status).toBe(200);
    const loginCode = await lastCodeTo(emails.mail, sent);
    const verified = await authCall("/two-factor/verify-otp", login.cookie, { code: loginCode });
    expect(verified.status).toBe(200);
    const fresh = merge(login.cookie, verified);
    expect((await onboarding(fresh)).account.email).toBe(emails.mail);

    // e o código de recuperação também entra para quem usa e-mail
    const again = await signInChallenge(emails.mail);
    expect((await authCall("/two-factor/verify-backup-code", again.cookie, { code: recoveryCodes![0] })).status).toBe(200);
    users.mail.cookie = cookie;
  });

  it("limite de envio do código por e-mail (por pessoa)", async () => {
    const strict = withTrustedProxy(() =>
      createAuth({ env, db: app.db, sendMail, otpEmailLimit: { cooldownMs: 60_000, max: 2, windowMs: 60_000 } }),
    );
    const login = await signInChallenge(emails.mail, strict.handler);
    expect((await authCall("/two-factor/send-otp", login.cookie, {}, strict.handler)).status).toBe(200);
    const second = await authCall("/two-factor/send-otp", login.cookie, {}, strict.handler);
    expect(second.status).toBe(429);
    expect(((await second.json()) as { code: string }).code).toBe("OTP_RATE_LIMITED");
  });

  it("trocar de método (app ↔ e-mail) e gerar novos códigos de recuperação", async () => {
    let { cookie } = users.app;
    // app → e-mail: os códigos de recuperação continuam os mesmos
    const sentBefore = mailsTo(emails.app);
    expect((await post("/v1/account/two-factor/email/setup", cookie, { password: PASSWORD })).status).toBe(200);
    const switched = await post("/v1/account/two-factor/email/confirm", cookie, { code: await lastCodeTo(emails.app, sentBefore) });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toEqual({ recoveryCodes: null });
    cookie = merge(cookie, switched);
    expect((await account(cookie)).twoFactor).toMatchObject({ enabled: true, method: "email" });
    expect((await signInChallenge(emails.app)).methods).toEqual(["otp"]);

    // novos códigos: senha errada recusa; certa devolve 10 novos
    expect(await errorCode(await post("/v1/account/two-factor/recovery-codes", cookie, { password: "senha-errada-000" }))).toBe("wrong_password");
    const regenerated = await post("/v1/account/two-factor/recovery-codes", cookie, { password: PASSWORD });
    expect(regenerated.status).toBe(200);
    const { recoveryCodes } = (await regenerated.json()) as { recoveryCodes: string[] };
    expect(recoveryCodes).toHaveLength(10);
    const login = await signInChallenge(emails.app);
    expect((await authCall("/two-factor/verify-backup-code", login.cookie, { code: recoveryCodes[1] })).status).toBe(200);

    // e-mail → app
    const setup = await post("/v1/account/two-factor/setup", cookie, { password: PASSWORD });
    expect(setup.status).toBe(200);
    const { secret } = (await setup.json()) as { secret: string };
    const confirmed = await post("/v1/account/two-factor/confirm", cookie, { code: totp(secret) });
    expect(confirmed.status).toBe(200);
    cookie = merge(cookie, confirmed);
    expect((await account(cookie)).twoFactor).toMatchObject({ enabled: true, method: "app" });
    expect((await signInChallenge(emails.app)).methods).toContain("totp");
    users.app.cookie = cookie;
  });

  it("\"Pular por enquanto\" é durável e idempotente; sem sessão, 401", async () => {
    const { cookie } = users.skip;
    expect((await onboarding(cookie)).security.skippedAt).toBeNull();
    // atalho do Better Auth que ligaria o e-mail sem conferir código nem gerar códigos de recuperação: fechado
    const shortcut = await authCall("/two-factor/enable", cookie, { password: PASSWORD, method: "otp" });
    expect(shortcut.status).toBe(400);
    expect(((await shortcut.json()) as { code: string }).code).toBe("USE_ACCOUNT_SETUP");
    expect((await onboarding(cookie)).security.twoFactorEnabled).toBe(false);
    expect((await api.request("/v1/onboarding/security/skip", { method: "POST" })).status).toBe(401);
    expect((await post("/v1/onboarding/security/skip", cookie)).status).toBe(200);
    const first = (await onboarding(cookie)).security;
    expect(first).toMatchObject({ twoFactorEnabled: false, method: null });
    expect(first.skippedAt).not.toBeNull();
    // de novo (outra aba, recarregar): mesma data, nada muda
    expect((await post("/v1/onboarding/security/skip", cookie)).status).toBe(200);
    expect((await onboarding(cookie)).security.skippedAt).toBe(first.skippedAt);
    // gravado no banco, na pessoa
    const [row] = await owner.db
      .select({ skippedAt: schema.user.onboardingSecuritySkippedAt })
      .from(schema.user)
      .where(eq(schema.user.id, users.skip.userId));
    expect(row?.skippedAt?.toISOString()).toBe(new Date(first.skippedAt!).toISOString());
  });

  it("isolamento: o 2FA e o \"pular\" de uma pessoa não mexem em outra; código de outra pessoa não vale", async () => {
    // "other" não pulou nem ativou, mesmo com "skip" pulado e "mail"/"app" ativos
    expect((await onboarding(users.other.cookie)).security).toEqual({ twoFactorEnabled: false, method: null, skippedAt: null });
    expect((await onboarding(users.skip.cookie)).security.twoFactorEnabled).toBe(false);

    // código enviado para "skip" não liga o 2FA de "other" (o código é preso à sessão de quem pediu)
    expect((await post("/v1/account/two-factor/email/setup", users.skip.cookie, { password: PASSWORD })).status).toBe(200);
    const codeOfSkip = await lastCodeTo(emails.skip, 0);
    const stolen = await post("/v1/account/two-factor/email/confirm", users.other.cookie, { code: codeOfSkip });
    expect(stolen.status).toBe(409);
    expect((await onboarding(users.other.cookie)).security.twoFactorEnabled).toBe(false);
    // e cada e-mail foi para a própria pessoa
    for (const [to] of sendMail.mock.calls.map((c) => [c[0].to])) expect(Object.values(emails)).toContain(to);
  });
});
