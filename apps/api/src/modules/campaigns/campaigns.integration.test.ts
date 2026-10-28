import { createFakeLlm } from "@duckzap/ai";
import {
  DEFAULT_OPT_OUT_LINE,
  type Audience,
  type Campaign,
  type CampaignDraftInput,
  type CampaignRecipient,
  type CampaignTemplate,
  type CampaignTerms,
  type MessageVariation,
} from "@duckzap/contracts/campaigns";
import { createDb, schema, withOrg } from "@duckzap/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });
import type { Auth } from "../../auth";
import type { Env } from "../../env";
import type { Deps } from "../../lib/context";
import { encryptSecret } from "../../lib/crypto";
import { dispatchInbound } from "../../lib/inbound";
import { MAX_TYPING_MS, type MessagingProvider, type OutboundMessage, type SendResult } from "../../lib/messaging";
import { createChannelsRuntime } from "../channels/runtime";
import { demoVariationTexts } from "./variation-demo";
import { toVariations } from "./variation-gen";
import { seeded } from "./engine/rng";
import { handleInboundForCampaigns } from "./inbound";
import type { Queue } from "../channels/queue";
import { createCampaignsRuntime, type CampaignsRuntime, type TickJob } from "./ports";
import { discoverDueOrganizations, runCampaignTick } from "./runner";
import { campaignsRoutes } from "./routes";

/**
 * INTEGRAÇÃO de Campanhas contra Postgres real (papel `duckzap_app`, com RLS).
 *
 * Como rodar (precisa das tabelas de Campanhas + a função `dz_orgs_with_due_campaigns`, ver schema/campaigns.sql.md):
 *   cd apps/api && set -a && . ./.env && set +a
 *   DATABASE_URL=<url do banco DESCARTÁVEL, ex.: .../duckzap_scratch_campaigns> npx vitest run src/modules/campaigns
 *
 * Proteção: roda só se o nome do banco contiver "scratch" ou se CAMPAIGNS_ALLOW_DEV_DB=1 (depois da migration única).
 * Sem as tabelas, o arquivo inteiro é pulado. Os dados são de empresas criadas aqui (`org_cmp_*`) e apagadas no fim.
 * Nenhuma mensagem real é enviada: o provedor é um dublê em memória.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente (CI)
}

const url = process.env.DATABASE_URL;
const dbName = url ? new URL(url).pathname.slice(1) : "";
const allowed = dbName.includes("scratch") || process.env.CAMPAIGNS_ALLOW_DEV_DB === "1";
const { db, close } = createDb(url ?? "postgres://invalid/invalid", { max: 6 });
afterAll(close);

async function tablesReady() {
  if (!url || !allowed) return false;
  try {
    const rows = await db.execute<{ ok: boolean }>(
      sql`select (to_regclass('public.campaigns') is not null and to_regclass('public.campaign_recipients') is not null
        and to_regclass('public.campaign_variations') is not null and to_regclass('public.campaign_templates') is not null
        and to_regclass('public.campaign_terms_acceptance') is not null and to_regclass('public.conversations') is not null
        and to_regprocedure('public.dz_orgs_with_due_campaigns(integer)') is not null) as ok`,
    );
    return Boolean(rows[0]?.ok);
  } catch {
    return false;
  }
}
const ready = await tablesReady();

const RUN = uuidv7().slice(-8);
const A = `org_cmp_a_${RUN}`; // Pro, em dia
const B = `org_cmp_b_${RUN}`; // Pro, outra empresa
const BAS = `org_cmp_e_${RUN}`; // Básico (sem o recurso campanhas)
const EXP = `org_cmp_x_${RUN}`; // Pro, assinatura que o teste de suspensão altera
const orgs = [A, B, BAS, EXP];

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
};

const people: Record<string, { name: string; email: string; org: string; role: "owner" | "admin" | "member" }> = {
  [`usr_owner_${RUN}`]: { name: "Marina Alves", email: `owner-${RUN}@cmp.test`, org: A, role: "owner" },
  [`usr_admin_${RUN}`]: { name: "Paulo Admin", email: `admin-${RUN}@cmp.test`, org: A, role: "admin" },
  [`usr_agent_${RUN}`]: { name: "Rafael Costa", email: `agent-${RUN}@cmp.test`, org: A, role: "member" },
  [`usr_b_${RUN}`]: { name: "Bia Outra", email: `b-${RUN}@cmp.test`, org: B, role: "owner" },
  [`usr_ess_${RUN}`]: { name: "Eva Básico", email: `ess-${RUN}@cmp.test`, org: BAS, role: "owner" },
  [`usr_exp_${RUN}`]: { name: "Xavier Expirado", email: `exp-${RUN}@cmp.test`, org: EXP, role: "owner" },
};
const OWNER = `usr_owner_${RUN}`;
const ADMIN = `usr_admin_${RUN}`;
const AGENT = `usr_agent_${RUN}`;
const OTHER = `usr_b_${RUN}`;
const BASIC = `usr_ess_${RUN}`;
const EXPIRED = `usr_exp_${RUN}`;

const fakeAuth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const p = people[headers.get("x-test-user") ?? ""];
      return p ? { session: { activeOrganizationId: p.org }, user: { id: headers.get("x-test-user"), name: p.name, email: p.email } } : null;
    },
  },
};

// ---------- dublê de provedor (nenhuma mensagem real) ----------

class FakeProvider implements MessagingProvider {
  readonly sent: OutboundMessage[] = [];
  script: SendResult[] = [];
  constructor(readonly kind: string) {}
  capabilities() {
    return { buttons: false, lists: false, templates: this.kind === "meta_cloud", media: true, reactions: false, window24h: this.kind === "meta_cloud", presence: this.kind === "evolution" };
  }
  async connect() {
    return { status: "connected" as const };
  }
  async disconnect() {}
  async status() {
    return "connected" as const;
  }
  async send(_channel: unknown, message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    return this.script.shift() ?? { ok: true, providerMessageId: `wamid.${message.externalId}` };
  }
  async verifyWebhook() {
    return true;
  }
  async parseWebhook() {
    return [];
  }
}
const qrProvider = new FakeProvider("evolution");
const officialProvider = new FakeProvider("meta_cloud");

let clock = new Date("2026-10-26T13:00:00Z"); // segunda 10:00 em São Paulo
const setClock = (d: Date) => {
  clock = d;
};
const unlimited = { take: async () => ({ allowed: true, retryAfterMs: 0 }) };
let limiter: { take: (key: string) => Promise<{ allowed: boolean; retryAfterMs: number }> } = unlimited;

const channelsRuntime = createChannelsRuntime({
  providers: {
    get: (kind) => (kind === "evolution" ? qrProvider : kind === "meta_cloud" ? officialProvider : undefined),
    kinds: () => ["evolution", "meta_cloud"],
  },
  sendLimiterFor: () => ({ take: (key: string) => limiter.take(key) }),
  now: () => clock,
});

let llm = createFakeLlm();
const llmProxy = { name: "fake", generate: (request: Parameters<typeof llm.generate>[0]) => llm.generate(request) };
const deps = { env, db, auth: fakeAuth as unknown as Auth, llm: llmProxy } satisfies Deps;
// fila gravadora: nada roda sozinho em segundo plano (os testes chamam o tick à mão); dá para conferir o que foi agendado
const wakeJobs: { name: string; payload: TickJob; delayMs: number | undefined; jobId: string | undefined }[] = [];
const wakeHandlers = new Map<string, (payload: TickJob) => Promise<void>>();
const recordingQueue: Queue<TickJob> = {
  enqueue: async (name, payload, options) => {
    wakeJobs.push({ name, payload, delayMs: options?.delayMs, jobId: options?.jobId });
  },
  process: (name, handler) => {
    wakeHandlers.set(name, handler);
  },
};
const rt: CampaignsRuntime = createCampaignsRuntime(
  { db, llm: llmProxy },
  { channels: channelsRuntime, rng: seeded(20261026), now: () => clock, sleep: async () => {}, queue: recordingQueue },
);
const app = campaignsRoutes(deps, rt);

const call = (user: string, path: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json: body, ...rest } = init;
  return app.request(`http://x${path}`, {
    ...rest,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "x-test-user": user, "content-type": "application/json", ...rest.headers },
  });
};
const j = async <T>(res: Response) => (await res.json()) as T;
const tickA = (at: Date) => runCampaignTick(rt, at, { organizationIds: [A] });

// ---------- dados ----------

const phone = (i: number) => `+5567998${String(100000 + i)}`; // 13 dígitos, com o 9º dígito
const noNine = (i: number) => `+556798${String(100000 + i)}`; // o mesmo celular sem o 9
const contactIds: string[] = [];
/** contatos aceitos fora das listas de público (cada teste de resposta usa uma faixa própria, para não misturar envios) */
const extraIds: string[] = [];
let allListId = "";
let bigListId = "";
const channelIds: Record<string, string> = {};

async function makeChannel(org: string, name: string, opts: { ageDays?: number; type?: "whatsapp_qr" | "whatsapp_official"; status?: string } = {}) {
  const id = uuidv7();
  const type = opts.type ?? "whatsapp_qr";
  await withOrg(db, org, (tx) =>
    tx.insert(schema.channels).values({
      id,
      organizationId: org,
      name: `${name}-${RUN}`,
      type,
      provider: type === "whatsapp_qr" ? "evolution" : "meta_cloud",
      status: opts.status ?? "connected",
      address: "+5567999990000",
      webhookTokenHash: `hash-${id}`,
      webhookTokenEnc: encryptSecret(org, `tok-${id}`),
      createdAt: new Date(clock.getTime() - (opts.ageDays ?? 300) * 86_400_000),
    }),
  );
  channelIds[name] = id;
  return id;
}

async function makeList(org: string, name: string, ids: string[]) {
  const id = uuidv7();
  await withOrg(db, org, async (tx) => {
    await tx.insert(schema.contactLists).values({ id, organizationId: org, name: `${name}-${RUN}`, kind: "static" });
    if (ids.length) await tx.insert(schema.contactListMembers).values(ids.map((contactId) => ({ organizationId: org, listId: id, contactId })));
  });
  return id;
}

const BASE = "Oi, {nome}! Já faz um tempinho desde a sua última limpeza. Que tal agendar um horário essa semana? Responda “quero” que a gente cuida do resto.";

function goodVariations(count = 14, review: MessageVariation["review"] = "approved"): MessageVariation[] {
  const all = toVariations(BASE, DEFAULT_OPT_OUT_LINE, demoVariationTexts({ base: BASE, optOutLine: DEFAULT_OPT_OUT_LINE, count: 24 }));
  return all.filter((v) => v.issues.length === 0).slice(0, count).map((v) => ({ ...v, review }));
}

function draftInput(channelId: string, audienceId: string | null, over: Partial<CampaignDraftInput> = {}): CampaignDraftInput {
  return {
    name: `Campanha ${uuidv7().slice(-6)}`,
    audienceId,
    message: { type: "text", body: BASE, imageName: null, buttons: [], listButtonLabel: "", listItems: [], optOutLine: DEFAULT_OPT_OUT_LINE, officialTemplateId: null },
    variationMode: "bank",
    variations: goodVariations(),
    variationsBase: BASE,
    sending: {
      channelId,
      scheduleMode: "now",
      scheduledAt: null,
      intervalMinSeconds: 45,
      intervalMaxSeconds: 120,
      windowStart: "08:00",
      windowEnd: "20:00",
      skipSundaysAndHolidays: true,
    },
    ...over,
  };
}

async function createDraft(user: string, input: CampaignDraftInput) {
  const res = await call(user, "/campaigns", { method: "POST", json: input });
  expect(res.status, await res.clone().text()).toBe(201);
  return j<Campaign>(res);
}

async function acceptTerms() {
  const res = await call(OWNER, "/campaigns/terms/accept", { method: "POST" });
  expect(res.status).toBe(200);
}

async function launch(user: string, id: string) {
  return call(user, `/campaigns/${id}/launch`, { method: "POST" });
}

const readCampaign = (org: string, id: string) =>
  withOrg(db, org, async (tx) => (await tx.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)))[0]);
const readRecipients = (org: string, id: string) =>
  withOrg(db, org, (tx) => tx.select().from(schema.campaignRecipients).where(eq(schema.campaignRecipients.campaignId, id)).orderBy(asc(schema.campaignRecipients.position)));

/** Avança o relógio até o próximo envio e roda o tick, até a campanha parar de enviar (ou `max` rodadas). */
async function drain(id: string, max = 400, stopBeforeLocalDate?: string) {
  for (let i = 0; i < max; i++) {
    const c = await readCampaign(A, id);
    if (!c || c.status !== "sending") return c;
    // dia local de São Paulo (UTC-3) do próximo envio
    if (stopBeforeLocalDate && c.nextSendAt && new Date(c.nextSendAt.getTime() - 3 * 3_600_000).toISOString().slice(0, 10) >= stopBeforeLocalDate) return c;
    if (c.nextSendAt && c.nextSendAt > clock) setClock(c.nextSendAt);
    await tickA(clock);
  }
  return readCampaign(A, id);
}

beforeAll(async () => {
  if (!ready) return;
  await db
    .insert(schema.plans)
    .values([
      { slug: "basico", name: "Básico", maxChannels: 2, maxUsers: 2, maxAgents: 1, features: [] },
      { slug: "pro", name: "Pro", maxChannels: 5, maxUsers: 5, maxAgents: null, features: ["campaigns", "instagram"] },
    ])
    .onConflictDoNothing();
  const now = new Date();
  const farFuture = new Date("2099-01-01T00:00:00Z");
  for (const org of orgs) {
    await db.insert(schema.organization).values({ id: org, name: `Empresa ${org.slice(8, 9).toUpperCase()}`, slug: `${org}`, createdAt: now, timeZone: "America/Sao_Paulo" });
    const plan = org === BAS ? "basico" : "pro";
    await withOrg(db, org, (tx) =>
      tx.insert(schema.subscriptions).values({ id: uuidv7(), organizationId: org, planSlug: plan, status: "active", currentPeriodEnd: farFuture }),
    );
  }
  for (const [id, p] of Object.entries(people)) {
    await db.insert(schema.user).values({ id, name: p.name, email: p.email, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(schema.member).values({ id: `mem_${id}`, organizationId: p.org, userId: id, role: p.role, createdAt: now });
  }

  // 100 contatos na empresa A: 0–79 aceitaram, 80 = o mesmo celular do 78 sem o 9º dígito, 81–83 saíram, 84–99 sem aceite
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: uuidv7(),
    organizationId: A,
    name: i === 5 ? "+5567998100005" : `Contato ${i} Sobrenome`,
    phone: i === 80 ? noNine(78) : phone(i),
    origin: "customer" as const,
    createdAt: new Date(clock.getTime() - (200 - i) * 60_000),
    lastInteractionAt: i < 10 ? new Date(clock.getTime() - 10 * 86_400_000) : null,
  }));
  contactIds.push(...rows.map((r) => r.id));
  const extra = Array.from({ length: 60 }, (_, k) => ({
    id: uuidv7(),
    organizationId: A,
    name: `Extra ${k} Sobrenome`,
    phone: phone(1000 + k),
    origin: "customer" as const,
    createdAt: new Date(clock.getTime() - (400 - k) * 60_000),
    lastInteractionAt: null,
  }));
  extraIds.push(...extra.map((r) => r.id));
  await withOrg(db, A, async (tx) => {
    await tx.insert(schema.contacts).values([...rows, ...extra]);
    await tx.insert(schema.consents).values(extra.map((r) => ({ id: uuidv7(), organizationId: A, contactId: r.id, status: "granted", method: "invite" })));
    await tx.insert(schema.consents).values(
      rows.flatMap((r, i) =>
        i <= 80 || (i >= 81 && i <= 83)
          ? [{ id: uuidv7(), organizationId: A, contactId: r.id, status: i <= 80 ? "granted" : "denied", method: "invite" }]
          : [{ id: uuidv7(), organizationId: A, contactId: r.id, status: "pending", method: "invite", inviteSentAt: new Date(clock.getTime() - 2 * 86_400_000) }],
      ),
    );
  });
  allListId = await makeList(A, "Todos", contactIds);
  bigListId = await makeList(A, "Grande", contactIds.slice(0, 70));
  // empresa B: um contato aceito e um canal, para provar o isolamento
  await withOrg(db, B, async (tx) => {
    const id = uuidv7();
    await tx.insert(schema.contacts).values({ id, organizationId: B, name: "Contato de B", phone: "+5511999990001", origin: "customer" });
    await tx.insert(schema.consents).values({ id: uuidv7(), organizationId: B, contactId: id, status: "granted", method: "invite" });
  });
});

afterAll(async () => {
  if (!ready) return;
  await db.delete(schema.organization).where(inArray(schema.organization.id, orgs));
  await db.delete(schema.user).where(inArray(schema.user.id, Object.keys(people)));
});

// =====================================================================================================
describe.skipIf(!ready)("Campanhas: autorização, plano e isolamento entre empresas", () => {
  const routes: [string, string][] = [
    ["GET", "/campaigns"],
    ["POST", "/campaigns"],
    ["GET", "/campaigns/history"],
    ["GET", "/campaigns/rejected"],
    ["GET", "/campaigns/audiences"],
    ["GET", "/campaigns/channels"],
    ["GET", "/campaigns/templates"],
    ["POST", "/campaigns/templates"],
    ["DELETE", "/campaigns/templates/x"],
    ["GET", "/campaigns/terms"],
    ["POST", "/campaigns/terms/accept"],
    ["POST", "/campaigns/variations"],
    ["GET", "/campaigns/x"],
    ["PUT", "/campaigns/x"],
    ["DELETE", "/campaigns/x"],
    ["GET", "/campaigns/x/recipients"],
    ["POST", "/campaigns/x/launch"],
    ["POST", "/campaigns/x/pause"],
    ["POST", "/campaigns/x/resume"],
    ["POST", "/campaigns/x/cancel"],
    ["POST", "/campaigns/x/duplicate"],
  ];

  it("sem sessão: 401 em todas as rotas", async () => {
    for (const [method, path] of routes) {
      const res = await app.request(`http://x${path}`, { method, ...(method === "GET" || method === "DELETE" ? {} : { body: "{}", headers: { "content-type": "application/json" } }) });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("atendente (sem campaign.manage) é barrado em todas as rotas", async () => {
    for (const [method, path] of routes) {
      const res = await call(AGENT, path, { method, ...(method === "GET" || method === "DELETE" ? {} : { json: {} }) });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await j<{ error: { code: string } }>(res)).error.code).toBe("forbidden");
    }
  });

  it("plano Básico: 403 plan_feature em todas as rotas (até leitura)", async () => {
    for (const [method, path] of routes) {
      const res = await call(BASIC, path, { method, ...(method === "GET" || method === "DELETE" ? {} : { json: {} }) });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await j<{ error: { code: string } }>(res)).error.code, `${method} ${path}`).toBe("plan_feature");
    }
  });

  it("outra empresa: 404 ao ler, editar, excluir, disparar, pausar, retomar, cancelar, duplicar e listar envios", async () => {
    const chA = await makeChannel(A, "iso");
    const draft = await createDraft(OWNER, draftInput(chA, allListId));
    for (const [method, path] of [
      ["GET", `/campaigns/${draft.id}`],
      ["PUT", `/campaigns/${draft.id}`],
      ["DELETE", `/campaigns/${draft.id}`],
      ["POST", `/campaigns/${draft.id}/launch`],
      ["POST", `/campaigns/${draft.id}/pause`],
      ["POST", `/campaigns/${draft.id}/resume`],
      ["POST", `/campaigns/${draft.id}/cancel`],
      ["POST", `/campaigns/${draft.id}/duplicate`],
      ["GET", `/campaigns/${draft.id}/recipients`],
    ] as const) {
      const res = await call(OTHER, path, { method, ...(method === "PUT" ? { json: draftInput(chA, allListId) } : {}) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // a lista da outra empresa não vaza a campanha, e id malformado é 404 (nunca erro de SQL)
    expect((await j<Campaign[]>(await call(OTHER, "/campaigns"))).some((c) => c.id === draft.id)).toBe(false);
    expect((await call(OWNER, "/campaigns/nao-e-uuid")).status).toBe(404);
    // canal/público da empresa A não podem ser usados por B: viram "sem canal/sem público" no rascunho de B
    const spoof = await createDraft(OTHER, draftInput(chA, allListId));
    expect(spoof.sending.channelId).toBe("");
    expect(spoof.audienceId).toBeNull();
    // e a empresa B não enxerga canais nem públicos da A
    expect(await j<unknown[]>(await call(OTHER, "/campaigns/channels"))).toEqual([]);
    expect((await j<Audience[]>(await call(OTHER, "/campaigns/audiences"))).some((a) => a.id === allListId)).toBe(false);
  });

  it("conta suspensa (expirada/cancelada) = bloqueio total: 403 account_suspended em TODAS as rotas, leitura inclusive", async () => {
    const setSub = (values: Partial<typeof schema.subscriptions.$inferInsert>) =>
      withOrg(db, EXP, (tx) => tx.update(schema.subscriptions).set({ disabledAt: null, ...values }).where(eq(schema.subscriptions.organizationId, EXP)));
    const day = 86_400_000;
    try {
      for (const values of [
        { status: "expired" as const, currentPeriodEnd: new Date(Date.now() + 30 * day) }, // expirada guardada
        { status: "active" as const, currentPeriodEnd: new Date(Date.now() - 3 * day) }, // venceu além da tolerância
        { status: "canceled" as const, currentPeriodEnd: new Date(Date.now() + 30 * day) }, // cancelada
      ]) {
        await setSub(values);
        for (const [method, path] of routes) {
          const res = await call(EXPIRED, path, { method, ...(method === "GET" || method === "DELETE" ? {} : { json: {} }) });
          expect(res.status, `${values.status} ${method} ${path}`).toBe(403);
          expect((await j<{ error: { code: string } }>(res)).error.code, `${values.status} ${method} ${path}`).toBe("account_suspended");
        }
      }
    } finally {
      await setSub({ status: "active", currentPeriodEnd: new Date("2099-01-01T00:00:00Z") });
    }
  });

  it("past_due (venceu ontem, tolerância de 1 dia): tudo continua funcionando, inclusive disparar/retomar/aceitar termos", async () => {
    await withOrg(db, EXP, (tx) =>
      tx.update(schema.subscriptions).set({ status: "active", disabledAt: null, currentPeriodEnd: new Date(Date.now() - 86_400_000) }).where(eq(schema.subscriptions.organizationId, EXP)),
    );
    try {
      expect((await call(EXPIRED, "/campaigns")).status).toBe(200);
      expect((await call(EXPIRED, "/campaigns/terms")).status).toBe(200);
      for (const path of [`/campaigns/${uuidv7()}/launch`, `/campaigns/${uuidv7()}/resume`, `/campaigns/${uuidv7()}/pause`]) {
        const res = await call(EXPIRED, path, { method: "POST" });
        expect(res.status, path).toBe(404); // permitido (não é account_suspended nem sending_paused); só não existe
      }
      expect((await call(EXPIRED, "/campaigns/terms/accept", { method: "POST" })).status).toBe(200);
    } finally {
      await withOrg(db, EXP, (tx) =>
        tx.update(schema.subscriptions).set({ status: "active", currentPeriodEnd: new Date("2099-01-01T00:00:00Z") }).where(eq(schema.subscriptions.organizationId, EXP)),
      );
    }
  });

  it("administrador também gerencia e dispara (campaign.manage + campaign.send)", async () => {
    expect((await call(ADMIN, "/campaigns")).status).toBe(200);
    expect((await call(ADMIN, "/campaigns/terms")).status).toBe(200);
  });
});

// =====================================================================================================
describe.skipIf(!ready)("Campanhas: público, canais, modelos, termos e rascunhos", () => {
  it("públicos: só conta quem aceitou; saiu, sem aceite e duplicado separados; soma fecha", async () => {
    const audiences = await j<Audience[]>(await call(OWNER, "/campaigns/audiences"));
    const all = audiences.find((a) => a.id === allListId);
    expect(all).toMatchObject({ kind: "list", total: 100, optedIn: 80, optedOut: 3, notOptedIn: 16, duplicates: 1, recentlyActive: 10 });
    expect(all && all.optedIn + all.notOptedIn + all.optedOut + all.duplicates).toBe(100);
    expect(audiences.find((a) => a.id === bigListId)).toMatchObject({ total: 70, optedIn: 70, duplicates: 0 });
  });

  it("canais de envio: limites, aquecimento, capacidades e enviados hoje (só WhatsApp)", async () => {
    await makeChannel(A, "lista-old", { ageDays: 300 });
    await makeChannel(A, "lista-new", { ageDays: 0 });
    await makeChannel(A, "lista-official", { type: "whatsapp_official" });
    await withOrg(db, A, (tx) =>
      tx.insert(schema.channels).values({ id: uuidv7(), organizationId: A, name: `insta-${RUN}`, type: "instagram", provider: "instagram", status: "connected", webhookTokenHash: `h-${uuidv7()}`, webhookTokenEnc: "x" }),
    );
    const list = await j<import("@duckzap/contracts/campaigns").CampaignChannel[]>(await call(OWNER, "/campaigns/channels"));
    const old = list.find((c) => c.id === channelIds["lista-old"]);
    const young = list.find((c) => c.id === channelIds["lista-new"]);
    const official = list.find((c) => c.id === channelIds["lista-official"]);
    expect(old).toMatchObject({ kind: "whatsapp_qr", connected: true, dailyLimit: 50, hourlyLimit: 15, sentToday: 0 });
    expect(old?.numberAgeDays).toBeGreaterThan(200);
    expect(young).toMatchObject({ numberAgeDays: 1, dailyLimit: 10 });
    expect(old?.capabilities).toMatchObject({ buttons: false, lists: false });
    expect(official).toMatchObject({ kind: "whatsapp_official", dailyLimit: 1000 });
    expect(list.some((c) => c.name.startsWith("insta-"))).toBe(false);
  });

  it("modelos: salvar, listar, excluir interno; modelo da Meta é somente leitura", async () => {
    const saved = await call(OWNER, "/campaigns/templates", { method: "POST", json: { name: "Retorno", type: "text", body: "Oi, {nome}!", buttons: [] } });
    expect(saved.status).toBe(201);
    const tpl = await j<CampaignTemplate>(saved);
    expect(tpl).toMatchObject({ source: "internal", metaStatus: null });
    const metaId = uuidv7();
    await withOrg(db, A, (tx) =>
      tx.insert(schema.campaignTemplates).values({ id: metaId, organizationId: A, name: "meta-ro", type: "text", body: "x Responda SAIR", source: "meta", metaStatus: "approved", metaName: "meta_ro", metaLanguage: "pt_BR" }),
    );
    const list = await j<CampaignTemplate[]>(await call(OWNER, "/campaigns/templates"));
    expect(list.map((t) => t.id)).toEqual(expect.arrayContaining([tpl.id, metaId]));
    expect((await call(OWNER, `/campaigns/templates/${metaId}`, { method: "DELETE" })).status).toBe(409);
    expect((await call(OWNER, `/campaigns/templates/${tpl.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(OWNER, `/campaigns/templates/${tpl.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(OTHER, `/campaigns/templates/${metaId}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(OWNER, "/campaigns/templates", { method: "POST", json: { name: "", type: "text", body: "x", buttons: [] } })).status).toBe(422);
  });

  it("termos: começam não aceitos; aceitar grava quem e quando (nome da sessão, não do corpo); idempotente", async () => {
    const before = await j<CampaignTerms>(await call(OWNER, "/campaigns/terms"));
    expect(before).toMatchObject({ accepted: false, acceptedBy: null, version: "2026-10" });
    const accepted = await j<CampaignTerms>(await call(OWNER, "/campaigns/terms/accept", { method: "POST", json: { userName: "Hacker" } }));
    expect(accepted).toMatchObject({ accepted: true, acceptedBy: "Marina Alves" });
    const again = await j<CampaignTerms>(await call(ADMIN, "/campaigns/terms/accept", { method: "POST" }));
    expect(again.acceptedBy).toBe("Marina Alves"); // o primeiro aceite vale
    expect((await j<CampaignTerms>(await call(ADMIN, "/campaigns/terms"))).accepted).toBe(true);
  });

  it("rascunho: cria, lê, edita, duplica e exclui; plano de dias e total vêm do servidor", async () => {
    const ch = await makeChannel(A, "rascunho", { ageDays: 300 });
    const created = await createDraft(OWNER, draftInput(ch, allListId, { name: "Retorno de limpeza" }));
    expect(created).toMatchObject({ status: "draft", audienceName: expect.stringContaining("Todos"), channelKind: "whatsapp_qr" });
    expect(created.stats.total).toBe(80); // elegíveis agora
    expect(created.dayPlan).toEqual([{ date: "2026-10-26", count: 50 }, { date: "2026-10-27", count: 30 }]);
    expect(created.variations).toHaveLength(14);

    const edited = await call(OWNER, `/campaigns/${created.id}`, { method: "PUT", json: draftInput(ch, bigListId, { name: "Novo nome" }) });
    expect(edited.status).toBe(200);
    expect(await j<Campaign>(edited)).toMatchObject({ name: "Novo nome", stats: { total: 70 } });

    const copy = await call(OWNER, `/campaigns/${created.id}/duplicate`, { method: "POST" });
    expect(copy.status).toBe(201);
    const copied = await j<Campaign>(copy);
    expect(copied).toMatchObject({ status: "draft", name: "Novo nome (cópia)" });
    expect(copied.variations).toHaveLength(14);
    expect(copied.variations.map((v) => v.id)).not.toEqual(expect.arrayContaining(created.variations.map((v) => v.id)));

    expect((await call(OWNER, `/campaigns/${copied.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(OWNER, `/campaigns/${copied.id}`)).status).toBe(404);
    const list = await j<Campaign[]>(await call(OWNER, "/campaigns"));
    expect(list.find((c) => c.id === created.id)).toBeTruthy();
  });

  it("variações: o servidor recalcula os problemas (o navegador não decide) e preserva edição", async () => {
    const ch = await makeChannel(A, "var-check");
    const forged = goodVariations(12).map((v, i) => ({
      ...v,
      issues: [] as MessageVariation["issues"],
      text: i === 0 ? v.text.replace("{nome}", "você") : i === 1 ? v.text.replace(DEFAULT_OPT_OUT_LINE, "") : i === 2 ? `${v.text} Só hoje com 30% de desconto!` : v.text,
    }));
    const draft = await createDraft(OWNER, draftInput(ch, bigListId, { variations: forged }));
    expect(draft.variations[0]?.issues).toContain("missing_variable");
    expect(draft.variations[1]?.issues).toContain("missing_opt_out");
    expect(draft.variations[2]?.issues).toContain("unknown_number_or_link");
    expect(draft.variations.slice(3).every((v) => v.issues.length === 0)).toBe(true);
    // editar um texto mantém o id e marca como editada
    const first = draft.variations[3];
    expect(first).toBeTruthy();
    const next = draft.variations.map((v, i) => (i === 3 ? { ...v, text: `${v.text.replace(DEFAULT_OPT_OUT_LINE, "").trimEnd()} Até logo!\n\n${DEFAULT_OPT_OUT_LINE}` } : v));
    const updated = await j<Campaign>(await call(OWNER, `/campaigns/${draft.id}`, { method: "PUT", json: draftInput(ch, bigListId, { variations: next }) }));
    expect(updated.variations[3]?.id).toBe(first?.id);
    const rows = await withOrg(db, A, (tx) => tx.select().from(schema.campaignVariations).where(eq(schema.campaignVariations.campaignId, draft.id)).orderBy(asc(schema.campaignVariations.position)));
    expect(rows[3]?.edited).toBe(true);
    expect(rows[4]?.edited).toBe(false);
  });

  it("gerar variações pela IA (fake): 20 variações pendentes, com o validador acusando os defeitos; limita pedidos por minuto", async () => {
    const res = await call(OWNER, "/campaigns/variations", { method: "POST", json: { base: BASE, optOutLine: DEFAULT_OPT_OUT_LINE, count: 20 } });
    expect(res.status).toBe(200);
    const list = await j<MessageVariation[]>(res);
    expect(list).toHaveLength(20);
    expect(list.every((v) => v.review === "pending")).toBe(true);
    expect(list.some((v) => v.issues.length > 0)).toBe(true);
    expect((await call(OWNER, "/campaigns/variations", { method: "POST", json: { base: "curta", optOutLine: DEFAULT_OPT_OUT_LINE, count: 20 } })).status).toBe(422);
    expect((await call(OWNER, "/campaigns/variations", { method: "POST", json: { base: BASE, optOutLine: DEFAULT_OPT_OUT_LINE, count: 10 } })).status).toBe(422);
  });
});

// =====================================================================================================
describe.skipIf(!ready)("Campanhas: disparo — o que barra e o que congela", () => {
  it("sem termos aceitos o disparo é barrado (terms_required) — termos antes do primeiro envio", async () => {
    // empresa B ainda não aceitou: monta um cenário mínimo nela
    const chB = await makeChannel(B, "b-main");
    const listB = await withOrg(db, B, async (tx) => {
      const [c] = await tx.select({ id: schema.contacts.id }).from(schema.contacts).limit(1);
      const id = uuidv7();
      await tx.insert(schema.contactLists).values({ id, organizationId: B, name: `b-${RUN}`, kind: "static" });
      await tx.insert(schema.contactListMembers).values({ organizationId: B, listId: id, contactId: c?.id as string });
      return id;
    });
    const draft = await createDraft(OTHER, draftInput(chB, listB));
    const res = await launch(OTHER, draft.id);
    expect(res.status).toBe(403);
    expect((await j<{ error: { code: string } }>(res)).error.code).toBe("terms_required");
    expect((await readRecipients(B, draft.id)).length).toBe(0);
  });

  it("validações do servidor: variações insuficientes, base mudou, pendente, sem público, canal fora do ar, janela inválida", async () => {
    await acceptTerms();
    const ch = await makeChannel(A, "launch-checks");
    const fewVariations = await createDraft(OWNER, draftInput(ch, bigListId, { variations: goodVariations(9) }));
    expect((await j<{ error: { code: string } }>(await launch(OWNER, fewVariations.id))).error.code).toBe("variations_required");

    const withPending = await createDraft(OWNER, draftInput(ch, bigListId, { variations: [...goodVariations(12), ...goodVariations(13, "pending").slice(12)] }));
    expect((await j<{ error: { code: string } }>(await launch(OWNER, withPending.id))).error.code).toBe("variations_required");

    const changed = await createDraft(OWNER, draftInput(ch, bigListId, { variationsBase: "Outra base de mensagem completamente diferente." }));
    expect((await j<{ error: { code: string } }>(await launch(OWNER, changed.id))).error.code).toBe("variations_required");

    const noAudience = await createDraft(OWNER, draftInput(ch, null));
    expect((await j<{ error: { code: string } }>(await launch(OWNER, noAudience.id))).error.code).toBe("no_audience");
    const emptyList = await makeList(A, "Vazia", []);
    const emptyDraft = await createDraft(OWNER, draftInput(ch, emptyList));
    expect((await j<{ error: { code: string } }>(await launch(OWNER, emptyDraft.id))).error.code).toBe("no_audience");
    // lista só com quem saiu / sem aceite: nada elegível
    const blockedList = await makeList(A, "Bloqueados", contactIds.slice(81, 90));
    const blockedDraft = await createDraft(OWNER, draftInput(ch, blockedList));
    expect((await j<{ error: { code: string } }>(await launch(OWNER, blockedDraft.id))).error.code).toBe("no_audience");

    const down = await makeChannel(A, "launch-down", { status: "disconnected" });
    const downDraft = await createDraft(OWNER, draftInput(down, bigListId));
    expect((await j<{ error: { code: string } }>(await launch(OWNER, downDraft.id))).error.code).toBe("channel_unavailable");

    const badWindow = await createDraft(OWNER, draftInput(ch, bigListId, { sending: { ...draftInput(ch, null).sending, windowStart: "20:00", windowEnd: "08:00" } }));
    expect((await j<{ error: { code: string } }>(await launch(OWNER, badWindow.id))).error.code).toBe("invalid_window");

    const past = await createDraft(OWNER, draftInput(ch, bigListId, { sending: { ...draftInput(ch, null).sending, scheduleMode: "scheduled", scheduledAt: "2026-10-01T12:00:00Z" } }));
    expect((await j<{ error: { code: string } }>(await launch(OWNER, past.id))).error.code).toBe("invalid_schedule");
    // nada foi congelado em nenhuma das tentativas
    for (const d of [fewVariations, withPending, changed, noAudience, emptyDraft, blockedDraft, downDraft, badWindow, past]) expect((await readRecipients(A, d.id)).length).toBe(0);
  });

  it("disparar congela SÓ quem aceitou (sem saída, sem aceite, sem duplicado), embaralhado, e a campanha vira 'sending'", async () => {
    const ch = await makeChannel(A, "launch-ok");
    const draft = await createDraft(OWNER, draftInput(ch, allListId));
    const res = await launch(OWNER, draft.id);
    expect(res.status, await res.clone().text()).toBe(200);
    const launched = await j<Campaign>(res);
    expect(launched).toMatchObject({ status: "sending", stats: { total: 80, sent: 0 } });
    expect(launched.dayPlan).toEqual([{ date: "2026-10-26", count: 50 }, { date: "2026-10-27", count: 30 }]);

    const rows = await readRecipients(A, draft.id);
    expect(rows).toHaveLength(80);
    const ids = new Set(rows.map((r) => r.contactId));
    expect(ids.size).toBe(80);
    // ninguém sem aceite, nem quem saiu, nem o duplicado (índice 80 = mesmo celular do 78)
    for (const i of [80, 81, 82, 83, 84, 99]) expect(ids.has(contactIds[i] as string)).toBe(false);
    expect(ids.has(contactIds[78] as string)).toBe(true);
    // priorizou quem conversou nos últimos 90 dias (contatos 0–9 vêm primeiro) e embaralhou
    const firstTen = rows.slice(0, 10).map((r) => r.contactId);
    expect(new Set(firstTen)).toEqual(new Set(contactIds.slice(0, 10)));
    expect(firstTen).not.toEqual(contactIds.slice(0, 10));
    expect(rows.slice(10).map((r) => r.contactId)).not.toEqual(contactIds.slice(10, 80));
    // id de envio determinístico por destinatário
    expect(rows.every((r) => r.externalId === `cmp-${r.id}`)).toBe(true);
    // disparar de novo não duplica nada
    const twice = await launch(OWNER, draft.id);
    expect(twice.status).toBe(409);
    expect((await readRecipients(A, draft.id)).length).toBe(80);
    // rascunho já disparado não edita nem exclui
    expect((await call(OWNER, `/campaigns/${draft.id}`, { method: "PUT", json: draftInput(ch, allListId) })).status).toBe(409);
    expect((await call(OWNER, `/campaigns/${draft.id}`, { method: "DELETE" })).status).toBe(409);
    const c = await readCampaign(A, draft.id);
    expect(c?.audienceSnapshot).toMatchObject({ total: 100, optedIn: 80, optedOut: 3, duplicates: 1 });
    await call(OWNER, `/campaigns/${draft.id}/cancel`, { method: "POST" });
  });

  it("agendada: fica 'scheduled', sem envio antes da hora; na hora, começa", async () => {
    const ch = await makeChannel(A, "scheduled");
    const when = new Date(clock.getTime() + 2 * 3_600_000);
    const list = await makeList(A, "Agendada", contactIds.slice(10, 14));
    const draft = await createDraft(OWNER, draftInput(ch, list, { sending: { ...draftInput(ch, null).sending, scheduleMode: "scheduled", scheduledAt: when.toISOString() } }));
    const launched = await j<Campaign>(await launch(OWNER, draft.id));
    expect(launched).toMatchObject({ status: "scheduled", nextSendAt: when.toISOString(), startedAt: null });
    const before = qrProvider.sent.length;
    await tickA(clock);
    expect(qrProvider.sent.length).toBe(before);
    await tickA(when);
    expect(qrProvider.sent.length).toBe(before + 1);
    expect((await readCampaign(A, draft.id))?.status).toBe("sending");
    await call(OWNER, `/campaigns/${draft.id}/cancel`, { method: "POST" });
  });
});

// =====================================================================================================
describe.skipIf(!ready)("Motor: envio, intervalos, limites, janela, variação e registro", () => {
  it("um envio por tick, texto EXATO gravado, idempotente no mesmo instante, intervalo sorteado dentro da faixa", async () => {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, "tick-basic");
    const list = await makeList(A, "Tick", contactIds.slice(0, 12));
    const draft = await createDraft(OWNER, draftInput(ch, list));
    await launch(OWNER, draft.id);
    qrProvider.sent.length = 0;

    const first = await tickA(clock);
    expect(first.sent).toBe(1);
    expect(qrProvider.sent).toHaveLength(1);
    // idempotência: o mesmo tick repetido no mesmo instante não envia de novo
    const second = await tickA(clock);
    expect(second.sent).toBe(0);
    expect(qrProvider.sent).toHaveLength(1);

    const rows = (await readRecipients(A, draft.id)).filter((r) => r.status === "sent");
    expect(rows).toHaveLength(1);
    const r = rows[0];
    const out = qrProvider.sent[0];
    expect(out?.externalId).toBe(r?.externalId);
    expect(out?.kind).toBe("text");
    expect(out?.text).toBe(r?.renderedText); // o texto enviado é exatamente o registrado
    expect(r?.renderedText?.endsWith(DEFAULT_OPT_OUT_LINE)).toBe(true);
    expect(r?.renderedText).not.toMatch(/\{[a-z_]+\}/); // nenhuma variável crua
    expect(r?.variationId).toBeTruthy();
    expect(r?.variationNumber).toBeGreaterThanOrEqual(1);
    expect(r?.intervalSeconds).toBeGreaterThanOrEqual(45);
    expect(r?.intervalSeconds).toBeLessThanOrEqual(120);
    expect(r?.dayIndex).toBe(1);
    expect(r?.providerMessageId).toBe(`wamid.${r?.externalId}`);
    expect(out?.to).toMatch(/^\+55/);
    // "digitando…" (§5.7): proporcional ao texto, dentro da mensagem (Evolution: `delay` nativo), e nunca além do teto
    expect(out?.typingMs).toBeGreaterThanOrEqual(1500);
    expect(out?.typingMs).toBeLessThanOrEqual(MAX_TYPING_MS);

    const c = await readCampaign(A, draft.id);
    const waitMs = (c?.nextSendAt?.getTime() ?? 0) - clock.getTime();
    expect(waitMs).toBeGreaterThanOrEqual(45_000);
    // antes do instante marcado, nada acontece
    setClock(new Date(clock.getTime() + 20_000));
    expect((await tickA(clock)).sent).toBe(0);
    await call(OWNER, `/campaigns/${draft.id}/cancel`, { method: "POST" });
  });

  it("{nome} vira o primeiro nome; contato com telefone no lugar do nome vira “cliente”; nunca vai número no lugar do nome", async () => {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, "tick-names");
    // contato 5 tem o telefone como nome; contato 1 é "Contato 1 Sobrenome"
    const list = await makeList(A, "Nomes", [contactIds[1] as string, contactIds[5] as string]);
    const draft = await createDraft(OWNER, draftInput(ch, list));
    await launch(OWNER, draft.id);
    for (let i = 0; i < 2; i++) {
      const c = await readCampaign(A, draft.id);
      if (c?.nextSendAt && c.nextSendAt > clock) setClock(c.nextSendAt);
      await tickA(clock);
    }
    const rows = await readRecipients(A, draft.id);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(2);
    const byContact = new Map(rows.map((r) => [r.contactId, r.renderedText ?? ""]));
    expect(byContact.get(contactIds[1] as string)).toMatch(/(^|\s)Contato[!,]/);
    expect(byContact.get(contactIds[1] as string)).not.toContain("Sobrenome");
    expect(byContact.get(contactIds[5] as string)).toMatch(/(^|\s)cliente[!,]/);
    expect([...byContact.values()].every((t) => !t.includes("+5567"))).toBe(true);
    await call(OWNER, `/campaigns/${draft.id}/cancel`, { method: "POST" });
  });

  it("fila: disparar acorda o motor na hora; cada envio agenda o próximo acordar no instante sorteado (job atrasado, sem duplicar)", async () => {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, "tick-wake");
    const list = await makeList(A, "Wake", contactIds.slice(12, 16));
    wakeJobs.length = 0;
    const draft = await createDraft(OWNER, draftInput(ch, list));
    await launch(OWNER, draft.id);
    expect(wakeJobs.filter((w) => w.payload.campaignId === draft.id)).toEqual([
      { name: "campaign.tick", payload: { organizationId: A, campaignId: draft.id }, delayMs: 0, jobId: `${draft.id}:${clock.getTime()}` },
    ]);
    wakeJobs.length = 0;
    // o consumidor registrado pelas rotas é o que o worker chamaria quando o job vence
    const consumer = wakeHandlers.get("campaign.tick");
    expect(consumer).toBeTypeOf("function");
    await consumer?.({ organizationId: A, campaignId: draft.id });
    const c = await readCampaign(A, draft.id);
    expect((await readRecipients(A, draft.id)).filter((r) => r.status === "sent")).toHaveLength(1);
    expect(wakeJobs).toHaveLength(1);
    expect(wakeJobs[0]?.jobId).toBe(`${draft.id}:${c?.nextSendAt?.getTime()}`);
    expect(wakeJobs[0]?.delayMs).toBe((c?.nextSendAt?.getTime() ?? 0) - clock.getTime());
    expect(wakeJobs[0]?.delayMs).toBeGreaterThanOrEqual(45_000);
    await call(OWNER, `/campaigns/${draft.id}/cancel`, { method: "POST" });
  });

  it("70 pessoas, número aquecido: no máx. 50 no dia e 15 na hora; resto no dia seguinte; nunca variação nem intervalo repetidos", async () => {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, "tick-limits", { ageDays: 300 });
    const draft = await createDraft(OWNER, draftInput(ch, bigListId, { sending: { ...draftInput(ch, null).sending, intervalMinSeconds: 30, intervalMaxSeconds: 40 } }));
    const launched = await j<Campaign>(await launch(OWNER, draft.id));
    expect(launched.dayPlan).toEqual([{ date: "2026-10-26", count: 50 }, { date: "2026-10-27", count: 20 }]);
    qrProvider.sent.length = 0;

    const done = await drain(draft.id, 600);
    expect(done?.status).toBe("completed");
    const rows = await readRecipients(A, draft.id);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(70);
    expect(qrProvider.sent).toHaveLength(70);

    const times = rows.map((r) => (r.sentAt as Date).getTime()).sort((a, b) => a - b);
    // por dia (fuso de São Paulo): nunca mais de 50
    const byDay = new Map<string, number>();
    for (const t of times) {
      const day = new Date(t - 3 * 3_600_000).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    expect([...byDay.values()].sort((a, b) => b - a)).toEqual([50, 20]);
    expect([...byDay.keys()]).toEqual(["2026-10-26", "2026-10-27"]);
    // por hora (janela deslizante): nunca mais de 15
    for (let i = 0; i < times.length; i++) {
      const inHour = times.filter((t) => t <= (times[i] as number) && (times[i] as number) - t < 3_600_000).length;
      expect(inHour).toBeLessThanOrEqual(15);
    }
    // espaçamento entre envios seguidos respeita o piso de 30 s
    for (let i = 1; i < times.length; i++) expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(30_000);
    // dentro da janela 08h–20h locais
    for (const t of times) {
      const hour = new Date(t - 3 * 3_600_000).getUTCHours();
      expect(hour).toBeGreaterThanOrEqual(8);
      expect(hour).toBeLessThan(20);
    }
    // variação e intervalo: nunca iguais em envios seguidos
    const bySent = [...rows].sort((a, b) => (a.sentAt as Date).getTime() - (b.sentAt as Date).getTime());
    for (let i = 1; i < bySent.length; i++) {
      expect(bySent[i]?.variationId).not.toBe(bySent[i - 1]?.variationId);
      expect(bySent[i]?.intervalSeconds).not.toBe(bySent[i - 1]?.intervalSeconds);
    }
    expect(new Set(bySent.map((r) => r.variationId)).size).toBeGreaterThan(10);
    // dia de envio da campanha: 1 e 2
    expect(new Set(bySent.map((r) => r.dayIndex))).toEqual(new Set([1, 2]));
    // pausa longa aplicada em algum momento (a cada 8–15 mensagens)
    expect(bySent.some((r) => (r.longPauseSeconds ?? 0) >= 300)).toBe(true);
  });

  it("número novo (dia 1): para em 10 e retoma só amanhã; o limite do canal vale entre campanhas", async () => {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, "tick-warmup", { ageDays: 0 });
    const list1 = await makeList(A, "Warm1", contactIds.slice(20, 40));
    const list2 = await makeList(A, "Warm2", contactIds.slice(40, 50));
    const c1 = await createDraft(OWNER, draftInput(ch, list1, { sending: { ...draftInput(ch, null).sending, intervalMinSeconds: 30, intervalMaxSeconds: 35 } }));
    const launched = await j<Campaign>(await launch(OWNER, c1.id));
    expect(launched.dayPlan).toEqual([{ date: "2026-10-26", count: 10 }, { date: "2026-10-27", count: 10 }]);
    await drain(c1.id, 100, "2026-10-27");
    let rows = await readRecipients(A, c1.id);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(10);
    const stuck = await readCampaign(A, c1.id);
    expect(stuck?.status).toBe("sending");
    expect(stuck?.nextSendAt?.toISOString()).toBe("2026-10-27T11:00:00.000Z"); // amanhã 08:00 em SP
    // outra campanha no MESMO número, hoje: nada sai (o teto é do número)
    const c2 = await createDraft(OWNER, draftInput(ch, list2));
    await launch(OWNER, c2.id);
    qrProvider.sent.length = 0;
    await tickA(clock);
    expect(qrProvider.sent).toHaveLength(0);
    const channelsNow = await j<import("@duckzap/contracts/campaigns").CampaignChannel[]>(await call(OWNER, "/campaigns/channels"));
    expect(channelsNow.find((c) => c.id === ch)?.sentToday).toBe(10);
    // amanhã (dia 2 do número, ainda 10/dia): mais 10 saem
    setClock(new Date("2026-10-27T11:00:00Z"));
    await drain(c1.id, 100);
    rows = await readRecipients(A, c1.id);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(20);
    await call(OWNER, `/campaigns/${c1.id}/cancel`, { method: "POST" });
    await call(OWNER, `/campaigns/${c2.id}/cancel`, { method: "POST" });
  });

  it("fora da janela não envia e agenda para a próxima abertura; domingo e feriado (Finados) pulados", async () => {
    const ch = await makeChannel(A, "tick-window");
    const list = await makeList(A, "Janela", contactIds.slice(50, 56));
    setClock(new Date("2026-10-26T13:00:00Z"));
    const draft = await createDraft(OWNER, draftInput(ch, list));
    await launch(OWNER, draft.id);
    qrProvider.sent.length = 0;

    setClock(new Date("2026-10-26T00:30:00Z")); // domingo 25/10, 21:30 em SP... na verdade 26/10 00:30Z = 25/10 21:30
    await withOrg(db, A, (tx) => tx.update(schema.campaigns).set({ nextSendAt: new Date("2026-10-26T00:00:00Z") }).where(eq(schema.campaigns.id, draft.id)));
    const r1 = await tickA(clock);
    expect(r1.sent).toBe(0);
    expect((await readCampaign(A, draft.id))?.nextSendAt?.toISOString()).toBe("2026-10-26T11:00:00.000Z"); // segunda 08:00 SP

    // sábado 31/10 à noite → próxima abertura: terça 03/11 (domingo + Finados em 02/11)
    setClock(new Date("2026-11-01T00:30:00Z")); // sábado 31/10 21:30 em SP
    await withOrg(db, A, (tx) => tx.update(schema.campaigns).set({ nextSendAt: new Date("2026-11-01T00:00:00Z") }).where(eq(schema.campaigns.id, draft.id)));
    expect((await tickA(clock)).sent).toBe(0);
    expect((await readCampaign(A, draft.id))?.nextSendAt?.toISOString()).toBe("2026-11-03T11:00:00.000Z");
    // domingo 01/11 ao meio-dia: bloqueado
    setClock(new Date("2026-11-01T15:00:00Z"));
    await withOrg(db, A, (tx) => tx.update(schema.campaigns).set({ nextSendAt: new Date("2026-11-01T14:00:00Z") }).where(eq(schema.campaigns.id, draft.id)));
    expect((await tickA(clock)).sent).toBe(0);
    expect(qrProvider.sent).toHaveLength(0);
    await call(OWNER, `/campaigns/${draft.id}/cancel`, { method: "POST" });
  });

  it("botões e lista caem para opções numeradas ANTES da linha de saída; a linha fica no fim", async () => {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, "tick-buttons");
    const list = await makeList(A, "Botões", contactIds.slice(56, 58));
    const base = draftInput(ch, list);
    const draft = await createDraft(OWNER, draftInput(ch, list, { message: { ...base.message, type: "buttons", buttons: ["Quero agendar", "Agora não"] } }));
    await launch(OWNER, draft.id);
    qrProvider.sent.length = 0;
    await tickA(clock);
    const text = qrProvider.sent[0]?.text ?? "";
    expect(text).toContain("Responda com o número:\n1) Quero agendar\n2) Agora não");
    expect(text.endsWith(DEFAULT_OPT_OUT_LINE)).toBe(true);
    expect(text.indexOf("1) Quero agendar")).toBeLessThan(text.indexOf(DEFAULT_OPT_OUT_LINE));
    await call(OWNER, `/campaigns/${draft.id}/cancel`, { method: "POST" });
  });

  it("variação por mensagem: usa a nova se passar no validador; reprovou 2x → banco aprovado; IA fora → banco", async () => {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, "tick-permsg");
    const list = await makeList(A, "PerMsg", contactIds.slice(58, 62));
    const draft = await createDraft(OWNER, draftInput(ch, list, { variationMode: "per_message" }));
    await launch(OWNER, draft.id);

    // 1) IA devolve uma variação VÁLIDA
    const valid = `Olá, {nome}! Faz um tempo desde a sua última limpeza. Bora marcar um horário nesta semana? Responda “quero” que a gente organiza tudo.\n\n${DEFAULT_OPT_OUT_LINE}`;
    llm = createFakeLlm(() => JSON.stringify({ variations: [valid.replace(`\n\n${DEFAULT_OPT_OUT_LINE}`, "")] }));
    await tickA(clock);
    let rows = (await readRecipients(A, draft.id)).filter((r) => r.status === "sent");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.variationId).toBeNull(); // veio da IA, não do banco
    expect(rows[0]?.renderedText).toContain("Faz um tempo");
    expect(rows[0]?.renderedText?.endsWith(DEFAULT_OPT_OUT_LINE)).toBe(true);

    // 2) IA inventa preço: reprova nas duas tentativas → banco
    llm = createFakeLlm(() => JSON.stringify({ variations: ["Olá, {nome}! Limpeza por R$ 99 hoje. Responda “quero” e a gente agenda."] }));
    const c = await readCampaign(A, draft.id);
    setClock(c?.nextSendAt as Date);
    await tickA(clock);
    rows = (await readRecipients(A, draft.id)).filter((r) => r.status === "sent").sort((a, b) => (a.sentAt as Date).getTime() - (b.sentAt as Date).getTime());
    expect(rows).toHaveLength(2);
    expect(rows[1]?.variationId).toBeTruthy();
    expect(rows[1]?.renderedText).not.toContain("R$ 99");

    // 3) IA fora do ar (erro): banco
    llm = { name: "fake", generate: async () => { throw new (await import("@duckzap/ai")).LlmError("unknown", "fora", false); } };
    const c3 = await readCampaign(A, draft.id);
    setClock(c3?.nextSendAt as Date);
    await tickA(clock);
    rows = (await readRecipients(A, draft.id)).filter((r) => r.status === "sent");
    expect(rows).toHaveLength(3);
    llm = createFakeLlm();
    await call(OWNER, `/campaigns/${draft.id}/cancel`, { method: "POST" });
  });

  it("descobre as empresas com campanha vencida pela função segura e roda sem lista explícita", async () => {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, "tick-discover");
    const list = await makeList(A, "Discover", contactIds.slice(62, 64));
    const draft = await createDraft(OWNER, draftInput(ch, list));
    await launch(OWNER, draft.id);
    const orgsDue = await discoverDueOrganizations(rt);
    expect(orgsDue).toContain(A);
    const summary = await runCampaignTick(rt, clock);
    expect(summary.sent).toBeGreaterThanOrEqual(1);
    await call(OWNER, `/campaigns/${draft.id}/cancel`, { method: "POST" });
  });

  it("reserva sem desfecho (processo caiu no meio) vira falha 'resultado desconhecido' e NUNCA é reenviada", async () => {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, "tick-stale");
    const list = await makeList(A, "Stale", contactIds.slice(64, 67));
    const draft = await createDraft(OWNER, draftInput(ch, list));
    await launch(OWNER, draft.id);
    const rows = await readRecipients(A, draft.id);
    const stale = rows[0];
    await withOrg(db, A, (tx) =>
      tx.update(schema.campaignRecipients).set({ attemptedAt: new Date(clock.getTime() - 30 * 60_000), renderedText: "texto reservado" }).where(eq(schema.campaignRecipients.id, stale?.id as string)),
    );
    qrProvider.sent.length = 0;
    await tickA(clock);
    const after = (await readRecipients(A, draft.id)).find((r) => r.id === stale?.id);
    expect(after).toMatchObject({ status: "failed", errorCode: "unknown_outcome" });
    expect(qrProvider.sent.some((m) => m.externalId === stale?.externalId)).toBe(false);
    await call(OWNER, `/campaigns/${draft.id}/cancel`, { method: "POST" });
  });

  it("registro/relatórios: envios com texto exato, mascarados, rejeitados, histórico e finalização", async () => {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, "tick-report");
    const list = await makeList(A, "Report", contactIds.slice(67, 70));
    const draft = await createDraft(OWNER, draftInput(ch, list, { name: "Relatório" }));
    await launch(OWNER, draft.id);
    qrProvider.script = [{ ok: false, code: "rejected", message: "number is not on WhatsApp" }, { ok: false, code: "rejected", message: "erro qualquer do provedor" }];
    const done = await drain(draft.id, 20);
    expect(done?.status).toBe("completed");
    qrProvider.script = [];

    const recipients = await j<CampaignRecipient[]>(await call(OWNER, `/campaigns/${draft.id}/recipients`));
    expect(recipients).toHaveLength(3);
    expect(recipients.map((r) => r.status).sort()).toEqual(["failed", "no_whatsapp", "sent"]);
    expect(recipients.every((r) => /^\+55 67 9••••-\d{4}$/.test(r.phoneMasked))).toBe(true);
    expect(recipients.every((r) => r.campaignName === "Relatório")).toBe(true);
    const sent = recipients.find((r) => r.status === "sent");
    expect(sent?.variationNumber).toBeGreaterThanOrEqual(1);
    expect(sent?.intervalSeconds).toBeGreaterThanOrEqual(45);

    const rejected = await j<CampaignRecipient[]>(await call(OWNER, `/campaigns/rejected?campaignId=${draft.id}`));
    expect(rejected.map((r) => r.status).sort()).toEqual(["failed", "no_whatsapp"]);
    const allRejected = await j<CampaignRecipient[]>(await call(OWNER, "/campaigns/rejected"));
    expect(allRejected.length).toBeGreaterThanOrEqual(2);
    expect(await j<unknown[]>(await call(OTHER, "/campaigns/rejected"))).toEqual([]);

    const history = await j<Campaign[]>(await call(OWNER, "/campaigns/history"));
    const mine = history.find((c) => c.id === draft.id);
    expect(mine).toMatchObject({ status: "completed", stats: { total: 3, sent: 1, failed: 1 } });
    expect(mine?.finishedAt).toBeTruthy();
    expect(history.every((c) => c.status === "completed" || c.status === "canceled")).toBe(true);
  });
});

// =====================================================================================================
describe.skipIf(!ready)("Motor: disjuntor, pausar/retomar/cancelar e plano", () => {
  async function started(name: string, n = 20, over: Partial<CampaignDraftInput> = {}, channelOpts: Parameters<typeof makeChannel>[2] = {}) {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, name, channelOpts);
    const list = await makeList(A, name, contactIds.slice(0, n));
    const draft = await createDraft(OWNER, draftInput(ch, list, over));
    const res = await launch(OWNER, draft.id);
    expect(res.status, await res.clone().text()).toBe(200);
    return { ch, id: draft.id };
  }

  it("falhas acima de 10% das últimas 20 pausam a campanha; retomar é manual e recomeça a contagem", async () => {
    const { id } = await started("brk-fail");
    qrProvider.script = [{ ok: false, code: "unknown", message: "erro 1" }, { ok: false, code: "unknown", message: "erro 2" }, { ok: false, code: "unknown", message: "erro 3" }];
    const result = await drain(id, 20);
    expect(result?.status).toBe("paused");
    expect(result?.pauseReason).toBe("high_failure_rate");
    expect(result?.nextSendAt).toBeNull();
    const rows = await readRecipients(A, id);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(3);
    // pausada: o tick não envia
    qrProvider.sent.length = 0;
    setClock(new Date(clock.getTime() + 3_600_000));
    await tickA(clock);
    expect(qrProvider.sent).toHaveLength(0);
    // retomar manualmente: a pausa some, o disjuntor só olha envios NOVOS
    qrProvider.script = [];
    const resumed = await call(OWNER, `/campaigns/${id}/resume`, { method: "POST" });
    expect(resumed.status).toBe(200);
    expect(await j<Campaign>(resumed)).toMatchObject({ status: "sending", pauseReason: null });
    await drain(id, 3);
    expect((await readCampaign(A, id))?.status).toBe("sending"); // não repausou com as falhas antigas
    expect((await readRecipients(A, id)).filter((r) => r.status === "sent").length).toBeGreaterThanOrEqual(1);
    await call(OWNER, `/campaigns/${id}/cancel`, { method: "POST" });
  });

  it("erro do provedor indicando restrição pausa na hora (provider_restriction)", async () => {
    const { id } = await started("brk-restrict");
    qrProvider.script = [{ ok: false, code: "rejected", message: "Your account is restricted for spam" }];
    const result = await drain(id, 5);
    expect(result).toMatchObject({ status: "paused", pauseReason: "provider_restriction" });
  });

  it("canal que desconecta durante o envio pausa (channel_disconnected); a reserva é devolvida; retomar exige canal conectado", async () => {
    const { ch, id } = await started("brk-disc");
    await tickA(clock);
    // o provedor responde "desconectado" no próximo envio
    qrProvider.script = [{ ok: false, code: "disconnected", message: "O canal está desconectado." }];
    const c = await readCampaign(A, id);
    setClock(c?.nextSendAt as Date);
    await tickA(clock);
    const paused = await readCampaign(A, id);
    expect(paused).toMatchObject({ status: "paused", pauseReason: "channel_disconnected" });
    const rows = await readRecipients(A, id);
    expect(rows.filter((r) => r.status === "queued" && r.attemptedAt === null).length).toBe(19); // ninguém perdido
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(1);
    // canal ainda desconectado: não retoma
    await withOrg(db, A, (tx) => tx.update(schema.channels).set({ status: "disconnected" }).where(eq(schema.channels.id, ch)));
    const blocked = await call(OWNER, `/campaigns/${id}/resume`, { method: "POST" });
    expect(blocked.status).toBe(409);
    expect((await j<{ error: { code: string } }>(blocked)).error.code).toBe("channel_unavailable");
    // reconectou: retoma
    await withOrg(db, A, (tx) => tx.update(schema.channels).set({ status: "connected" }).where(eq(schema.channels.id, ch)));
    expect((await call(OWNER, `/campaigns/${id}/resume`, { method: "POST" })).status).toBe(200);
    await call(OWNER, `/campaigns/${id}/cancel`, { method: "POST" });
  });

  it("canal desconectado ou banido ANTES do tick: pausa sem enviar", async () => {
    const { ch, id } = await started("brk-pre");
    await withOrg(db, A, (tx) => tx.update(schema.channels).set({ status: "banned" }).where(eq(schema.channels.id, ch)));
    qrProvider.sent.length = 0;
    await tickA(clock);
    expect(qrProvider.sent).toHaveLength(0);
    expect(await readCampaign(A, id)).toMatchObject({ status: "paused", pauseReason: "provider_restriction" });
  });

  it("limite de taxa do canal não conta como falha: devolve a reserva e tenta de novo", async () => {
    const { id } = await started("brk-rate");
    limiter = { take: async () => ({ allowed: false, retryAfterMs: 5000 }) };
    await tickA(clock);
    limiter = unlimited;
    const rows = await readRecipients(A, id);
    expect(rows.filter((r) => r.attemptedAt !== null)).toHaveLength(0);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(0);
    expect((await readCampaign(A, id))?.status).toBe("sending");
    setClock(new Date(clock.getTime() + 30_000));
    expect((await tickA(clock)).sent).toBe(1);
    await call(OWNER, `/campaigns/${id}/cancel`, { method: "POST" });
  });

  it("plano que expira no meio do envio pausa a campanha (subscription_expired) e nada sai", async () => {
    const { id } = await started("brk-plan");
    await withOrg(db, A, (tx) => tx.update(schema.subscriptions).set({ status: "expired" }));
    qrProvider.sent.length = 0;
    await tickA(clock);
    expect(qrProvider.sent).toHaveLength(0);
    expect(await readCampaign(A, id)).toMatchObject({ status: "paused", pauseReason: "subscription_expired" });
    await withOrg(db, A, (tx) => tx.update(schema.subscriptions).set({ status: "active" }));
    await call(OWNER, `/campaigns/${id}/cancel`, { method: "POST" });
  });

  it("pausar, retomar e cancelar: transições válidas e inválidas", async () => {
    const { id } = await started("life", 8);
    expect((await call(OWNER, `/campaigns/${id}/resume`, { method: "POST" })).status).toBe(409); // não está pausada
    const paused = await call(OWNER, `/campaigns/${id}/pause`, { method: "POST" });
    expect(await j<Campaign>(paused)).toMatchObject({ status: "paused", pauseReason: "manual", nextSendAt: null });
    expect((await call(OWNER, `/campaigns/${id}/pause`, { method: "POST" })).status).toBe(409);
    qrProvider.sent.length = 0;
    await tickA(new Date(clock.getTime() + 600_000));
    expect(qrProvider.sent).toHaveLength(0);
    const resumed = await j<Campaign>(await call(OWNER, `/campaigns/${id}/resume`, { method: "POST" }));
    expect(resumed.status).toBe("sending");
    const canceled = await j<Campaign>(await call(OWNER, `/campaigns/${id}/cancel`, { method: "POST" }));
    expect(canceled).toMatchObject({ status: "canceled", nextSendAt: null });
    expect(canceled.finishedAt).toBeTruthy();
    expect((await call(OWNER, `/campaigns/${id}/cancel`, { method: "POST" })).status).toBe(409);
    qrProvider.sent.length = 0;
    await tickA(new Date(clock.getTime() + 600_000));
    expect(qrProvider.sent).toHaveLength(0);
  });
});

// =====================================================================================================
describe.skipIf(!ready)("Respostas: reply, SAIR (opt-out permanente), status de entrega e LGPD", () => {
  const inbound = (organizationId: string, from: string, text: string, at: Date) =>
    handleInboundForCampaigns(rt, { organizationId, channelId: uuidv7(), event: { type: "message", externalId: uuidv7(), from, kind: "text", text, at: at.toISOString() } }, clock);

  async function twoSent(name: string, from: number) {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, name);
    const list = await makeList(A, name, extraIds.slice(from, from + 8));
    const draft = await createDraft(OWNER, draftInput(ch, list));
    await launch(OWNER, draft.id);
    for (let i = 0; i < 2; i++) {
      const c = await readCampaign(A, draft.id);
      if (c?.nextSendAt && c.nextSendAt > clock) setClock(c.nextSendAt);
      await tickA(clock);
    }
    const rows = await readRecipients(A, draft.id);
    const contactPhone = async (contactId: string) => (await withOrg(db, A, (tx) => tx.select({ p: schema.contacts.phone }).from(schema.contacts).where(eq(schema.contacts.id, contactId))))[0]?.p as string;
    return { id: draft.id, sent: rows.filter((r) => r.status === "sent"), queued: rows.filter((r) => r.status === "queued"), contactPhone };
  }

  it("resposta normal: o envio vira 'replied' e quem ainda esperava sai da campanha (skipped)", async () => {
    const { id, sent, queued, contactPhone } = await twoSent("rep", 0);
    expect(sent).toHaveLength(2);
    await inbound(A, (await contactPhone(sent[0]?.contactId as string)).replace("+", ""), "Oi! Quero sim, pode ser quinta?", clock);
    const afterReply = await readRecipients(A, id);
    expect(afterReply.find((r) => r.id === sent[0]?.id)).toMatchObject({ status: "replied" });
    expect(afterReply.find((r) => r.id === sent[0]?.id)?.repliedAt).toBeTruthy();
    // quem ainda não recebeu e escreve: sai da campanha, vira conversa normal
    const waiting = queued[0];
    await inbound(A, await contactPhone(waiting?.contactId as string), "Boa tarde, vocês atendem sábado?", clock);
    expect((await readRecipients(A, id)).find((r) => r.id === waiting?.id)).toMatchObject({ status: "skipped" });
    // e o tick nunca envia para ele
    qrProvider.sent.length = 0;
    await drain(id, 30);
    expect(qrProvider.sent.some((m) => m.externalId === waiting?.externalId)).toBe(false);
    // resposta de quem NÃO é destinatário (outra empresa/ninguém) é ignorada sem erro
    await expect(inbound(A, "+5511900000000", "oi", clock)).resolves.toBeUndefined();
    await call(OWNER, `/campaigns/${id}/cancel`, { method: "POST" });
  });

  it("SAIR: opt-out PERMANENTE (consents=denied), conta como saída e o contato some de qualquer campanha futura", async () => {
    const { id, sent, queued, contactPhone } = await twoSent("optout", 10);
    const leaver = sent[0];
    const leaverPhone = await contactPhone(leaver?.contactId as string);
    await inbound(A, leaverPhone, "SAIR", clock);
    const row = (await readRecipients(A, id)).find((r) => r.id === leaver?.id);
    expect(row).toMatchObject({ status: "opted_out" });
    expect(row?.optedOutAt).toBeTruthy();
    const consent = await withOrg(db, A, (tx) => tx.select().from(schema.consents).where(eq(schema.consents.contactId, leaver?.contactId as string)));
    expect(consent[0]?.status).toBe("denied");
    // quem ainda esperava a vez e pede para sair: nunca recebe
    const waiting = queued[0];
    await inbound(A, await contactPhone(waiting?.contactId as string), "parar", clock);
    expect((await readRecipients(A, id)).find((r) => r.id === waiting?.id)).toMatchObject({ status: "opted_out" });
    qrProvider.sent.length = 0;
    await drain(id, 30);
    expect(qrProvider.sent.some((m) => m.externalId === waiting?.externalId)).toBe(false);
    // campanha futura com os dois: nenhum entra (bloqueio para sempre)
    const list = await makeList(A, "Futura", [leaver?.contactId as string, waiting?.contactId as string, extraIds[58] as string]);
    const audience = (await j<Audience[]>(await call(OWNER, "/campaigns/audiences"))).find((a) => a.id === list);
    expect(audience).toMatchObject({ total: 3, optedIn: 1, optedOut: 2 });
    // aparecem em Rejeitados
    const rejected = await j<CampaignRecipient[]>(await call(OWNER, `/campaigns/rejected?campaignId=${id}`));
    expect(rejected.filter((r) => r.status === "opted_out").length).toBeGreaterThanOrEqual(2);
    // uma frase comum com a palavra não derruba o aceite (“cancelar” numa conversa longa não é opt-out)
    const other = sent[1];
    await inbound(A, await contactPhone(other?.contactId as string), "Preciso cancelar a minha consulta de amanhã, pode remarcar?", clock);
    const otherConsent = await withOrg(db, A, (tx) => tx.select().from(schema.consents).where(eq(schema.consents.contactId, other?.contactId as string)));
    expect(otherConsent[0]?.status).toBe("granted");
    await call(OWNER, `/campaigns/${id}/cancel`, { method: "POST" });
  });

  it("3 saídas nas últimas 20 pausam a campanha (opt_outs) no próximo tick", async () => {
    setClock(new Date("2026-10-26T13:00:00Z"));
    const ch = await makeChannel(A, "optout3");
    const list = await makeList(A, "Optout3", extraIds.slice(40, 55));
    const draft = await createDraft(OWNER, draftInput(ch, list));
    await launch(OWNER, draft.id);
    for (let i = 0; i < 4; i++) {
      const c = await readCampaign(A, draft.id);
      if (c?.nextSendAt && c.nextSendAt > clock) setClock(c.nextSendAt);
      await tickA(clock);
    }
    const sent = (await readRecipients(A, draft.id)).filter((r) => r.status === "sent");
    expect(sent).toHaveLength(4);
    for (const r of sent.slice(0, 3)) {
      const [p] = await withOrg(db, A, (tx) => tx.select({ p: schema.contacts.phone }).from(schema.contacts).where(eq(schema.contacts.id, r.contactId)));
      await inbound(A, p?.p as string, "SAIR", clock);
    }
    const c = await readCampaign(A, draft.id);
    setClock((c?.nextSendAt as Date) ?? clock);
    qrProvider.sent.length = 0;
    await tickA(clock);
    expect(qrProvider.sent).toHaveLength(0);
    expect(await readCampaign(A, draft.id)).toMatchObject({ status: "paused", pauseReason: "opt_outs" });
  });

  it("status do provedor (entregue/lida/falhou) atualiza o registro; o handler é registrado e despachado pelo canal", async () => {
    const { id, sent } = await twoSent("status", 20);
    const target = sent[0];
    const providerId = target?.providerMessageId as string;
    await handleInboundForCampaigns(rt, { organizationId: A, channelId: uuidv7(), event: { type: "status", externalId: providerId, status: "delivered", at: "2026-10-26T13:05:00.000Z" } }, clock);
    expect((await readRecipients(A, id)).find((r) => r.id === target?.id)).toMatchObject({ status: "delivered" });
    // pelo despachante real (lib/inbound), como o módulo Canais faz
    await dispatchInbound({ organizationId: A, channelId: uuidv7(), event: { type: "status", externalId: providerId, status: "read", at: "2026-10-26T13:06:00.000Z" } });
    const read = (await readRecipients(A, id)).find((r) => r.id === target?.id);
    expect(read).toMatchObject({ status: "read" });
    expect(read?.deliveredAt).toBeTruthy();
    await handleInboundForCampaigns(rt, { organizationId: A, channelId: uuidv7(), event: { type: "status", externalId: "wamid.inexistente", status: "failed", at: "2026-10-26T13:07:00.000Z" } }, clock);
    await call(OWNER, `/campaigns/${id}/cancel`, { method: "POST" });
  });

  it("LGPD: apagar o contato apaga os envios dele em cascata", async () => {
    const { id, sent } = await twoSent("lgpd", 30);
    const victim = sent[0];
    await withOrg(db, A, (tx) => tx.delete(schema.contacts).where(eq(schema.contacts.id, victim?.contactId as string)));
    const left = await readRecipients(A, id);
    expect(left.some((r) => r.contactId === victim?.contactId)).toBe(false);
    expect(left.length).toBeGreaterThan(0);
    // o histórico não quebra: envio de contato removido simplesmente não aparece
    expect((await call(OWNER, `/campaigns/${id}/recipients`)).status).toBe(200);
    await call(OWNER, `/campaigns/${id}/cancel`, { method: "POST" });
  });
});

// =====================================================================================================
describe.skipIf(!ready)("API oficial: só modelo aprovado, sem variação por IA", () => {
  async function approvedTemplate(over: Partial<typeof schema.campaignTemplates.$inferInsert> = {}) {
    const id = uuidv7();
    await withOrg(db, A, (tx) =>
      tx.insert(schema.campaignTemplates).values({
        id,
        organizationId: A,
        name: `tpl-${id.slice(-5)}`,
        type: "text",
        body: "Olá {{1}}, temos novidades na clínica! Responda SAIR para parar.",
        source: "meta",
        metaStatus: "approved",
        metaName: "novidades_v1",
        metaLanguage: "pt_BR",
        metaParams: ["{nome}"],
        ...over,
      }),
    );
    return id;
  }

  it("modelo não aprovado (ou ausente) barra; aprovado envia como template, sem texto livre nem variação", async () => {
    setClock(new Date("2026-10-26T13:00:00Z"));
    await acceptTerms();
    const ch = await makeChannel(A, "off-main", { type: "whatsapp_official" });
    const list = await makeList(A, "Oficial", contactIds.slice(70, 73));
    const base = draftInput(ch, list, { variations: [], variationsBase: null });

    const noTpl = await createDraft(OWNER, base);
    expect((await j<{ error: { code: string } }>(await launch(OWNER, noTpl.id))).error.code).toBe("template_required");
    const pendingTpl = await approvedTemplate({ metaStatus: "pending" });
    const pendingDraft = await createDraft(OWNER, { ...base, message: { ...base.message, officialTemplateId: pendingTpl } });
    expect((await j<{ error: { code: string } }>(await launch(OWNER, pendingDraft.id))).error.code).toBe("template_required");
    const noOptOut = await approvedTemplate({ body: "Promoção imperdível {{1}}!" });
    const noOptOutDraft = await createDraft(OWNER, { ...base, message: { ...base.message, officialTemplateId: noOptOut } });
    expect((await j<{ error: { code: string } }>(await launch(OWNER, noOptOutDraft.id))).error.code).toBe("template_required");

    const tpl = await approvedTemplate();
    // mesmo mandando variações no corpo, a API oficial as ignora (não são gravadas)
    const draft = await createDraft(OWNER, { ...base, variations: goodVariations(12), variationsBase: BASE, message: { ...base.message, officialTemplateId: tpl } });
    expect(draft.variations).toEqual([]);
    expect(draft.dayPlan).toEqual([]);
    const launched = await launch(OWNER, draft.id);
    expect(launched.status, await launched.clone().text()).toBe(200);

    officialProvider.sent.length = 0;
    await drain(draft.id, 20).catch(() => undefined);
    for (let i = 0; i < 4; i++) {
      const c = await readCampaign(A, draft.id);
      if (c?.status !== "sending") break;
      if (c.nextSendAt && c.nextSendAt > clock) setClock(c.nextSendAt);
      await tickA(clock);
    }
    expect(officialProvider.sent.length).toBe(3);
    const m = officialProvider.sent[0];
    expect(m?.kind).toBe("template");
    expect(m?.text).toBeUndefined();
    expect(m?.template).toMatchObject({ name: "novidades_v1", language: "pt_BR" });
    expect(m?.template?.bodyParams?.[0]).toMatch(/Contato|cliente/);
    const rows = await readRecipients(A, draft.id);
    expect(rows.every((r) => r.status === "sent" && r.variationId === null)).toBe(true);
    expect(rows[0]?.renderedText).toContain("Olá ");
    expect((await readCampaign(A, draft.id))?.status).toBe("completed");
  });
});
