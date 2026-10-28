import { LlmError, type GenerateRequest, type GenerateResult, type LLMProvider } from "@duckzap/ai";
import { agentGeneratorOutputSchema } from "@duckzap/contracts/agents";
import { createDb, schema, withOrg } from "@duckzap/db";
import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Auth } from "../../auth";
import type { Env } from "../../env";
import type { Deps } from "../../lib/context";
import { createSecondOrg, hasSecondOrgSupport, type SecondOrg } from "../../test-support/second-org";
import { agentsRoutes } from "./routes";

// INTEGRAÇÃO de POST /v1/agents/generate: Postgres real (papel duckzap_app) + LLM roteirizado (nunca provedor real).
// Empresas criadas pelo próprio teste (ativas); a do seed não é tocada.
const url = process.env.DATABASE_URL;
const enabled = Boolean(url) && hasSecondOrgSupport() && process.env.LLM_PROVIDER === "fake";

const examples = Array.from({ length: 9 }, (_, i) => ({ customer: `Pergunta ${i + 1}`, agent: `Resposta ${i + 1}` }));
const validProfile = {
  description: "Atende clientes e encaminha orçamentos ao comercial",
  instructions: "Você é a Duda, assistente da Nexora.\nPapel e objetivo: ...",
  companySummary: "A Nexora faz sites e sistemas.",
  companyInfo: "## Sobre a empresa\nA Nexora faz sites e sistemas.\n\n## Perguntas frequentes\nP: Vocês fazem site?\nR: Sim.",
  restrictions: "- Nunca inventar preços.",
  examples,
  warnings: ["Faltam as formas de pagamento."],
};
const body = {
  purpose: "sales",
  agentName: "Duda",
  tone: "friendly",
  companyText: "A Nexora faz sites, sistemas e automações para empresas. Atendemos de segunda a sexta.",
  hours: "Seg a sex, 8h às 18h",
};

describe.skipIf(!enabled)("Agentes: POST /agents/generate (integração)", () => {
  const { db, close } = createDb(url ?? "postgres://invalid/invalid", { max: 3 });
  const env = { NODE_ENV: "test" } as Env;

  let main: SecondOrg; // ativa, plano Básico
  let member: SecondOrg["members"][string];
  let other: SecondOrg; // outra empresa
  let suspended: SecondOrg;
  const orgs: SecondOrg[] = [];

  const sessions: Record<string, unknown> = {};
  const session = (org: SecondOrg, who: { userId: string; name?: string; userName?: string; email?: string; userEmail?: string }) => ({
    user: { id: who.userId, name: who.name ?? who.userName, email: who.email ?? who.userEmail },
    session: { id: `s_${who.userId}`, activeOrganizationId: org.orgId },
  });

  let llmCalls: GenerateRequest[] = [];
  let script: (request: GenerateRequest, n: number) => string | Error = () => JSON.stringify(validProfile);
  const llm: LLMProvider = {
    name: "fake",
    async generate(request) {
      llmCalls.push(request);
      const out = script(request, llmCalls.length);
      if (out instanceof Error) throw out;
      return { text: out, toolCalls: [], stopReason: "end", usage: { inputTokens: 3000, outputTokens: 2000 }, model: "fake-smart", provider: "fake" } satisfies GenerateResult;
    },
  };

  const deps = {
    env,
    db,
    llm,
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null } } as unknown as Auth,
  } satisfies Deps;

  let allowed = true;
  let limitCalls: string[] = [];
  const app = agentsRoutes(deps, {
    generatorLimit: {
      allow: (key) => {
        limitCalls.push(key);
        return allowed;
      },
    },
    generatorRetry: { delaysMs: [0, 0], sleep: async () => {} },
  });
  const post = (as: string | null, payload: unknown) =>
    app.request("http://x/agents/generate", {
      method: "POST",
      headers: { "content-type": "application/json", ...(as ? { "x-test-user": as } : {}) },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  const usageRows = (orgId: string) =>
    withOrg(db, orgId, (tx) => tx.select().from(schema.aiUsageLog).where(eq(schema.aiUsageLog.purpose, "agent_generator")));
  const agentCount = (orgId: string) =>
    withOrg(db, orgId, async (tx) => {
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.agents);
      return row?.n ?? 0;
    });

  beforeAll(async () => {
    main = await createSecondOrg("gen", { extra: [{ key: "atendente", role: "member" }] });
    other = await createSecondOrg("gen2");
    suspended = await createSecondOrg("gensusp", { status: "expired", daysToEnd: -60 });
    orgs.push(main, other, suspended);
    member = main.members.atendente!;
    sessions.owner = session(main, main);
    sessions.member = session(main, member);
    sessions.other = session(other, other);
    sessions.suspended = session(suspended, suspended);
  });

  afterAll(async () => {
    for (const o of orgs) await o.remove();
    await close();
  });

  beforeEach(() => {
    llmCalls = [];
    limitCalls = [];
    allowed = true;
    script = () => JSON.stringify(validProfile);
  });

  it("sem sessão: 401; sem permissão (atendente): 403; conta suspensa: 403 account_suspended", async () => {
    expect((await post(null, body)).status).toBe(401);
    const forbidden = await post("member", body);
    expect(forbidden.status).toBe(403);
    expect((await json(forbidden)).error.code).toBe("forbidden");
    const susp = await post("suspended", body);
    expect(susp.status).toBe(403);
    expect((await json(susp)).error.code).toBe("account_suspended");
    expect(llmCalls).toHaveLength(0);
  });

  it("422 invalid_input (pt-BR, com campos) e não gasta limite nem IA", async () => {
    for (const bad of [{ ...body, purpose: "marketing" }, { ...body, companyText: "x".repeat(20_001) }, { purpose: "sales", agentName: "Duda", tone: "friendly" }, "não é json"]) {
      const res = await post("owner", bad);
      expect(res.status).toBe(422);
      const data = await json(res);
      expect(data.error.code).toBe("invalid_input");
      expect(typeof data.error.message).toBe("string");
    }
    const noText = await json(await post("owner", { purpose: "sales", agentName: "Duda", tone: "friendly" }));
    expect(noText.error.message).toContain("Conte um pouco sobre a empresa");
    expect(noText.error.fields.companyText).toBeDefined();
    expect(llmCalls).toHaveLength(0);
    expect(limitCalls).toHaveLength(0);
  });

  it("200: devolve o perfil (contrato), registra uso agent_generator na empresa certa e NÃO grava agente", async () => {
    const agentsBefore = await agentCount(main.orgId);
    const res = await post("owner", body);
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(agentGeneratorOutputSchema.safeParse(data).success).toBe(true);
    expect(data.warnings).toContain("Faltam as formas de pagamento.");
    expect(data.examples).toHaveLength(9);
    expect(data.companyInfo).toContain("## Perguntas frequentes");
    expect(data.restrictions).toBe("- Nunca inventar preços.");
    expect(data.productsAndServices).toBe("");
    expect(data.faq).toBe("");

    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.tier).toBe("best");
    expect(llmCalls[0]!.meta).toEqual({ organizationId: main.orgId, purpose: "agent_generator" });
    expect(limitCalls).toEqual([main.orgId]);

    const rows = await usageRows(main.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "agent_generator", inputTokens: 3000, outputTokens: 2000, agentId: null, conversationId: null });
    expect(await usageRows(other.orgId)).toHaveLength(0);
    expect(await agentCount(main.orgId)).toBe(agentsBefore);
  });

  it("200: missingFields do modelo chega validado (chave desconhecida cai; campo já preenchido no corpo nunca é listado)", async () => {
    script = () => JSON.stringify({ ...validProfile, missingFields: ["hours", "paymentMethods", "location", "cpf"] });
    const res = await post("owner", body); // body traz "hours"
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(agentGeneratorOutputSchema.safeParse(data).success).toBe(true);
    expect(data.missingFields).toEqual(["paymentMethods", "location"]);
  });

  it("429 rate_limited quando o limite da empresa estoura (sem chamar a IA)", async () => {
    allowed = false;
    const res = await post("owner", body);
    expect(res.status).toBe(429);
    expect((await json(res)).error.code).toBe("rate_limited");
    expect(llmCalls).toHaveLength(0);
  });

  it("503 ai_unavailable quando o provedor falha de forma passageira (após repetir), sem registrar uso", async () => {
    script = () => new LlmError("overloaded", "529", true);
    const res = await post("owner", body);
    expect(res.status).toBe(503);
    expect((await json(res)).error.code).toBe("ai_unavailable");
    expect(llmCalls.length).toBe(3); // 1 + 2 novas tentativas
  });

  it("502 generation_failed quando a resposta é inválida 2 vezes; os tokens gastos entram no uso", async () => {
    const before = (await usageRows(other.orgId)).length;
    script = () => "isto não é JSON";
    const res = await post("other", body);
    expect(res.status).toBe(502);
    expect((await json(res)).error.code).toBe("generation_failed");
    expect(llmCalls).toHaveLength(2);
    expect((await usageRows(other.orgId)).length - before).toBe(2);
  });

  it("502 também para erro não repetível do provedor (ex.: chave inválida)", async () => {
    script = () => new LlmError("auth", "chave inválida", false);
    const res = await post("owner", body);
    expect(res.status).toBe(502);
    const data = await json(res);
    expect(data.error.code).toBe("generation_failed");
    expect(JSON.stringify(data)).not.toContain("chave");
  });

  it("402 budget_exceeded quando o orçamento mensal de tokens do plano acabou (sem chamar a IA)", async () => {
    const broke = await createSecondOrg("genbroke");
    orgs.push(broke);
    sessions.broke = session(broke, broke);
    await withOrg(db, broke.orgId, (tx) =>
      tx.insert(schema.aiUsageLog).values({
        id: uuidv7(),
        organizationId: broke.orgId,
        purpose: "agent_turn",
        provider: "fake",
        model: "fake",
        inputTokens: 5_000_000,
        outputTokens: 0,
        cachedInputTokens: 0,
      }),
    );
    const res = await post("broke", body);
    expect(res.status).toBe(402);
    const data = await json(res);
    expect(data.error.code).toBe("budget_exceeded");
    expect(data.error.message).toContain("limite de IA");
    expect(llmCalls).toHaveLength(0);
  });
});
