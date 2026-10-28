import { brand } from "@duckzap/brand";
import type { Database } from "@duckzap/db";
import { schema } from "@duckzap/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization, twoFactor } from "better-auth/plugins";
import { v7 as uuidv7 } from "uuid";
import type { Env } from "./env";
import type { Mailer } from "./lib/mailer";
import { CLIENT_IP_HEADER, guardAuthHandler, type LoginThrottle } from "./middleware/auth-handler";
import { loadSecurityConfig } from "./middleware/security-config";
import { hasOnlyInactiveMemberships } from "./modules/team/access";
import { sql } from "drizzle-orm";

/** O navegador chega na API por `<origem>/api/...` (proxy do front); o proxy tira o `/api` antes de chegar aqui. */
export function publicApiParts(env: Env) {
  const url = new URL(env.PUBLIC_API_URL);
  return { origin: url.origin, prefix: url.pathname.replace(/\/$/, "") };
}

/** Aviso ao dono do e-mail quando alguém tenta cadastrar uma conta nova com ele (no máximo 1 por hora por e-mail). */
function createExistingAccountNotifier(sendMail: Mailer) {
  const lastSent = new Map<string, number>();
  return (email: string, name: string) => {
    const now = Date.now();
    if ((lastSent.get(email) ?? 0) > now - 3_600_000) return;
    lastSent.set(email, now);
    if (lastSent.size > 10_000) for (const [k, t] of lastSent) if (t <= now - 3_600_000) lastSent.delete(k);
    // sem await: o tempo de resposta não pode diferir de um cadastro novo
    void sendMail({
      to: email,
      subject: `Alguém tentou criar uma conta com o seu e-mail no ${brand.name}`,
      text: `Oi, ${name}!

Alguém tentou se cadastrar no ${brand.name} com este e-mail, mas ele já tem conta. Nada foi alterado.

Se foi você, entre com a sua senha (ou use "Esqueci minha senha"). Se não foi, ignore este e-mail.`,
    }).catch(() => undefined);
  };
}

export function createAuth({
  env,
  db,
  sendMail,
  loginThrottle,
}: {
  env: Env;
  db: Database;
  sendMail: Mailer;
  loginThrottle?: LoginThrottle;
}) {
  const { origin, prefix } = publicApiParts(env);
  const security = loadSecurityConfig();
  const notifyExistingAccount = createExistingAccountNotifier(sendMail);
  const auth = betterAuth({
    appName: brand.name,
    baseURL: origin,
    basePath: `${prefix}/v1/auth`,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: env.WEB_ORIGINS,
    database: drizzleAdapter(db, { provider: "pg", schema, usePlural: false }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendMail({
          to: user.email,
          subject: `Redefinir sua senha no ${brand.name}`,
          text: `Oi, ${user.name}!\n\nPara criar uma senha nova, abra o link abaixo (vale por 1 hora):\n${url}\n\nSe não foi você, ignore este e-mail.`,
        });
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      storage: "memory",
      // cadastro: poucas contas por minuto por IP (anti-abuso); login já cai na regra padrão do Better Auth
      customRules: { "/sign-up/email": { window: 60, max: 5 } },
    },
    hooks: {
      // Cadastro: não revela se o e-mail já tem conta (resposta igual a qualquer outra falha de cadastro; o dono é avisado por e-mail)
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email.trim().toLowerCase() : "";
        if (!email) return;
        const [existing] = await db
          .select({ name: schema.user.name })
          .from(schema.user)
          .where(sql`lower(${schema.user.email}) = ${email}`)
          .limit(1);
        if (!existing) return;
        notifyExistingAccount(email, existing.name);
        throw new APIError("UNPROCESSABLE_ENTITY", {
          code: "SIGN_UP_FAILED",
          message: "Não foi possível criar a conta com esses dados. Confira o e-mail (se já tiver conta, enviamos um aviso para ele) ou entre com a sua senha.",
        });
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // pessoa inativada na Equipe não consegue abrir sessão nova
          before: async (session) => {
            if (await hasOnlyInactiveMemberships(db, session.userId)) {
              throw new APIError("FORBIDDEN", { message: "Sua conta está inativa. Fale com o administrador da empresa." });
            }
          },
        },
      },
    },
    advanced: {
      cookiePrefix: "dz",
      useSecureCookies: env.NODE_ENV === "production",
      database: { generateId: () => uuidv7() },
      // o IP vem de um cabeçalho interno que o `guardAuthHandler` recalcula (socket / último x-forwarded-for); o do cliente é ignorado
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    plugins: [
      organization({
        creatorRole: "owner",
        // o convite vai por e-mail com id opaco (uuid v7), e o aceite exige sessão do e-mail convidado;
        // por isso não exigimos e-mail verificado (o cadastro não verifica e-mail)
        requireEmailVerificationOnInvitation: false,
        schema: {
          organization: {
            additionalFields: {
              timeZone: { type: "string", required: false, defaultValue: "America/Sao_Paulo" },
            },
          },
        },
      }),
      twoFactor({ issuer: brand.name }),
    ],
  });

  // HTTP: só a superfície do produto, IP confiável e limite de tentativas por conta (ver middleware/auth-handler.ts)
  const handler = guardAuthHandler(auth.handler, {
    basePath: `${prefix}/v1/auth`,
    trustProxy: security.trustProxy,
    ...(loginThrottle ? { loginThrottle } : {}),
  });
  return { ...auth, handler };
}

export type Auth = ReturnType<typeof createAuth>;
