import { createFakeLlm } from "@duckzap/ai";
import { createDb, schema } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../../lib/context";
import { onError } from "../../middleware/error-handler";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { homeRoutes } from "./routes";

/**
 * INTEGRAÇÃO — "Primeiros passos" do Início (`setup` em GET /v1/home/overview), Postgres real com o papel do app (RLS).
 * Rode SOMENTE contra um banco descartável:
 *
 *   TEST_DB_NAME=duckzap_scratch_home ONLY_PACKAGE=api bash scripts/test-all.sh home
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const enabled = process.env.CONVERSATIONS_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_ADMIN_URL);

type Setup = {
  whatsappConnected: boolean;
  activeAgent: boolean;
  businessHours: boolean;
  hasProduct: boolean;
  teamInvited: boolean;
  hasConversation: boolean;
  twoFactorEnabled: boolean;
};

const allFalse: Setup = {
  whatsappConnected: false,
  activeAgent: false,
  businessHours: false,
  hasProduct: false,
  teamInvited: false,
  hasConversation: false,
  twoFactorEnabled: false,
};

const week = (open: boolean) => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: open && day > 0 && day < 6, start: "09:00", end: "18:00" }));

describe.skipIf(!enabled)("Início — Primeiros passos (integração)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 4 });
  const owner = createDb(process.env.DATABASE_ADMIN_URL ?? "postgres://invalid/invalid", { max: 2 });
  afterAll(async () => {
    await close();
    await owner.close();
  });

  const sessions: Record<string, unknown> = {};
  const deps = {
    db,
    llm: createFakeLlm(),
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null } },
  } as unknown as Deps;
  const app = new OpenAPIHono();
  app.route("/v1", homeRoutes(deps));
  app.onError(onError);

  const setupOf = async (as: string) => {
    const res = await app.request("/v1/home/overview", { headers: { "x-test-user": as } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { setup: Setup }).setup;
  };

  let main: SecondOrg;
  let other: SecondOrg;

  /** Deixa uma empresa "toda configurada" com o dono do banco (fixtures diretas, sem passar pelas telas). */
  async function configure(org: SecondOrg, opts: { hoursOpen: boolean; channelStatus: string }) {
    const orgId = org.orgId;
    await owner.db.transaction(async (tx) => {
      await tx.insert(schema.organizationSettings).values({ organizationId: orgId, businessHours: week(opts.hoursOpen), followUp: {}, inactivityClose: {} });
      await tx.insert(schema.channels).values({
        id: uuidv7(),
        organizationId: orgId,
        name: `WhatsApp ${uuidv7().slice(-6)}`,
        type: "whatsapp_qr",
        provider: "evolution",
        status: opts.channelStatus,
        webhookTokenHash: randomBytes(16).toString("hex"),
        webhookTokenEnc: "x",
      });
      await tx.insert(schema.agents).values({ id: uuidv7(), organizationId: orgId, job: "support", status: "active" });
      await tx.insert(schema.products).values({ id: uuidv7(), organizationId: orgId, name: `Produto ${uuidv7().slice(-6)}` });
      const contactId = uuidv7();
      await tx.insert(schema.contacts).values({ id: contactId, organizationId: orgId, name: "Cliente teste" });
      await tx.insert(schema.conversations).values({ id: uuidv7(), organizationId: orgId, contactId });
      await tx.insert(schema.invitation).values({
        id: `inv_${uuidv7()}`,
        organizationId: orgId,
        email: `convite_${uuidv7().slice(-8)}@example.test`,
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId: org.userId,
      });
      await tx.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, org.userId));
    });
  }

  beforeAll(async () => {
    main = await createSecondOrg("inicio-setup");
    // a outra empresa tem TUDO configurado: nada dela pode vazar para a primeira
    other = await createSecondOrg("inicio-setup-outra", { extra: [{ key: "atendente", role: "member", name: "Bia Atendente" }] });
    sessions.owner = { user: { id: main.userId, name: main.userName, email: main.userEmail }, session: { id: "s1", activeOrganizationId: main.orgId } };
    sessions.otherAgent = {
      user: { id: other.members.atendente!.userId, name: "Bia Atendente", email: other.members.atendente!.email },
      session: { id: "s2", activeOrganizationId: other.orgId },
    };
    await configure(other, { hoursOpen: true, channelStatus: "connected" });
  });
  afterAll(async () => {
    await main?.remove();
    await other?.remove();
  });

  it("empresa nova: nada feito, e os dados de outra empresa não contam", async () => {
    expect(await setupOf("owner")).toEqual(allFalse);
  });

  it("canal desconectado e horário todo fechado não contam como feitos", async () => {
    await configure(main, { hoursOpen: false, channelStatus: "disconnected" });
    expect(await setupOf("owner")).toEqual({
      ...allFalse,
      activeAgent: true,
      hasProduct: true,
      teamInvited: true,
      hasConversation: true,
      twoFactorEnabled: true,
    });
  });

  it("canal conectado e um dia aberto: tudo feito", async () => {
    await owner.db.update(schema.channels).set({ status: "connected" }).where(eq(schema.channels.organizationId, main.orgId));
    await owner.db.update(schema.organizationSettings).set({ businessHours: week(true) }).where(eq(schema.organizationSettings.organizationId, main.orgId));
    expect(await setupOf("owner")).toEqual({
      whatsappConnected: true,
      activeAgent: true,
      businessHours: true,
      hasProduct: true,
      teamInvited: true,
      hasConversation: true,
      twoFactorEnabled: true,
    });
  });

  it("atendente recebe os fatos da empresa e a SUA verificação em duas etapas (a tela filtra por papel)", async () => {
    // outra pessoa (a dona) existe na empresa: equipe conta; o 2FA é o da atendente, não o da dona
    expect(await setupOf("otherAgent")).toMatchObject({ whatsappConnected: true, teamInvited: true, twoFactorEnabled: false });
  });
});
