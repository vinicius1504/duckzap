import { createFakeLlm } from "@duckzap/ai";
import type { Agent, AgentConfig } from "@duckzap/contracts/agents";
import { createDb, schema, withOrg } from "@duckzap/db";
import { eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Auth } from "../../auth";
import type { Env } from "../../env";
import type { Deps } from "../../lib/context";
import { createDbKnowledgePort } from "./knowledge-store";
import { agentsRoutes } from "./routes";

// INTEGRAÇÃO: Postgres real (papel duckzap_app) + seed de dev. Depende das tabelas novas do módulo
// (agents, agent_versions, agent_documents, knowledge_chunks, copilot_*, ai_usage_log) e das extensões
// pg_trgm/vector: só roda depois da migration única; antes disso o arquivo inteiro é pulado.
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente (CI)
}

const url = process.env.DATABASE_URL;
const { db, close } = createDb(url ?? "postgres://invalid/invalid", { max: 3 });
afterAll(close);

async function tablesReady() {
  if (!url) return false;
  try {
    const rows = await db.execute<{ ok: boolean }>(
      sql`select (to_regclass('public.agents') is not null and to_regclass('public.agent_versions') is not null
        and to_regclass('public.knowledge_chunks') is not null and to_regclass('public.ai_usage_log') is not null) as ok`,
    );
    return Boolean(rows[0]?.ok);
  } catch {
    return false;
  }
}
const ready = await tablesReady();

// A = empresa do seed (plano Pro, em dia). B e S são empresas criadas aqui (plano Básico, em dia): "outra empresa" e
// "empresa que muda de status". Nunca usamos org_lume (o seed a deixa EXPIRADA de propósito, ou seja, suspensa) e nunca
// alteramos a assinatura do seed: outros arquivos de teste rodam em paralelo contra a org_alvorada.
const RUN = uuidv7().slice(-8);
const A = "org_alvorada";
const B = `org_agt_b_${RUN}`;
const S = `org_agt_s_${RUN}`;
const extraOrgs = [B, S];

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
const people: Record<string, { name: string; email: string; org: string }> = {
  usr_marina: { name: "Marina Alves", email: "marina@casaalvorada.com.br", org: A },
  usr_rafael: { name: "Rafael Costa", email: "rafael@casaalvorada.com.br", org: A },
  [`usr_b_${RUN}`]: { name: "Bia Outra", email: `b-${RUN}@agt.test`, org: B },
  [`usr_s_${RUN}`]: { name: "Sara Status", email: `s-${RUN}@agt.test`, org: S },
};
const USER_B = `usr_b_${RUN}`;
const USER_S = `usr_s_${RUN}`;
const fakeAuth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const p = people[headers.get("x-test-user") ?? ""];
      return p ? { session: { activeOrganizationId: p.org }, user: { id: headers.get("x-test-user"), name: p.name, email: p.email } } : null;
    },
  },
};
const deps = { env, db, auth: fakeAuth as unknown as Auth, llm: createFakeLlm() } satisfies Deps;
const app = agentsRoutes(deps);
const call = (user: string, path: string, init: RequestInit = {}) =>
  app.request(`http://x${path}`, { ...init, headers: { "x-test-user": user, "content-type": "application/json", ...init.headers } });
const json = async <T>(res: Response) => (await res.json()) as T;

const created: { org: string; id: string }[] = [];
const staffType = uuidv7();
const normalType = uuidv7();

async function createAgent(user: string, org: string, body: object) {
  const res = await call(user, "/agents", { method: "POST", body: JSON.stringify(body) });
  if (res.status === 201) {
    const agent = await json<Agent>(res.clone());
    created.push({ org, id: agent.id });
  }
  return res;
}

/** Empresa de teste, ativa, no plano Básico (a tabela `plans` vem do seed; `subscriptions.plan_slug` tem FK). */
async function createOrg(id: string, userId: string, periodEnd: Date) {
  const now = new Date();
  const p = people[userId];
  await db.insert(schema.organization).values({ id, name: `Empresa ${id}`, slug: id, createdAt: now, timeZone: "America/Sao_Paulo" });
  await withOrg(db, id, (tx) =>
    tx.insert(schema.subscriptions).values({ id: uuidv7(), organizationId: id, planSlug: "basico", status: "active", currentPeriodEnd: periodEnd }),
  );
  await db.insert(schema.user).values({ id: userId, name: p?.name ?? userId, email: p?.email ?? `${userId}@agt.test`, emailVerified: true, createdAt: now, updatedAt: now });
  await db.insert(schema.member).values({ id: `mem_${userId}`, organizationId: id, userId, role: "owner", createdAt: now });
}

beforeAll(async () => {
  if (!ready) return;
  const future = new Date(Date.now() + 30 * 86_400_000);
  await createOrg(B, USER_B, future);
  await createOrg(S, USER_S, future);
  await withOrg(db, A, (tx) =>
    tx.insert(schema.appointmentTypes).values([
      { id: staffType, organizationId: A, name: `Canal-teste-${staffType.slice(0, 6)}`, durationMinutes: 90, staffOnly: true },
      { id: normalType, organizationId: A, name: `Limpeza-teste-${normalType.slice(0, 6)}`, durationMinutes: 45, staffOnly: false },
    ]),
  );
});

afterAll(async () => {
  if (!ready) return;
  for (const org of [A]) {
    const ids = created.filter((c) => c.org === org).map((c) => c.id);
    if (ids.length) await withOrg(db, org, (tx) => tx.delete(schema.agents).where(inArray(schema.agents.id, ids)));
  }
  await withOrg(db, A, (tx) => tx.delete(schema.appointmentTypes).where(inArray(schema.appointmentTypes.id, [staffType, normalType])));
  await withOrg(db, A, (tx) => tx.delete(schema.copilotSettings));
  await db.delete(schema.organization).where(inArray(schema.organization.id, extraOrgs)); // leva agentes, assinatura e vínculos junto
  await db.delete(schema.user).where(inArray(schema.user.id, [USER_B, USER_S]));
});

describe.skipIf(!ready)("Agentes: autorização", () => {
  it("sem sessão: 401", async () => {
    expect((await app.request("http://x/agents")).status).toBe(401);
  });

  it("conta suspensa (canceled, disabled_at ou vencida além da tolerância) recebe 403 account_suspended; past_due na tolerância passa", async () => {
    const day = 86_400_000;
    const setSub = (values: Partial<typeof schema.subscriptions.$inferInsert>) =>
      withOrg(db, S, (tx) => tx.update(schema.subscriptions).set({ disabledAt: null, ...values }).where(eq(schema.subscriptions.organizationId, S)));
    const suspendedCode = async () => {
      const res = await call(USER_S, "/agents");
      return { status: res.status, code: ((await res.json()) as { error?: { code: string } }).error?.code };
    };
    // em dia
    await setSub({ status: "active", currentPeriodEnd: new Date(Date.now() + 30 * day) });
    expect((await call(USER_S, "/agents")).status).toBe(200);
    // venceu ontem (1 dia de atraso no calendário de Brasília): tolerância (past_due) — continua funcionando
    await setSub({ status: "active", currentPeriodEnd: new Date(Date.now() - day) });
    expect((await call(USER_S, "/agents")).status).toBe(200);
    // venceu há 3 dias: expirada, bloqueio total
    await setSub({ status: "active", currentPeriodEnd: new Date(Date.now() - 3 * day) });
    expect(await suspendedCode()).toEqual({ status: 403, code: "account_suspended" });
    // cancelada guardada, mesmo com o período em dia
    await setSub({ status: "canceled", currentPeriodEnd: new Date(Date.now() + 30 * day) });
    expect(await suspendedCode()).toEqual({ status: 403, code: "account_suspended" });
    // desativada pelo painel (disabled_at), mesmo "active" e em dia
    await setSub({ status: "active", currentPeriodEnd: new Date(Date.now() + 30 * day), disabledAt: new Date() });
    expect(await suspendedCode()).toEqual({ status: 403, code: "account_suspended" });
    // e as rotas de escrita também
    expect((await call(USER_S, "/agents", { method: "POST", body: JSON.stringify({ name: "x", job: "support", channelIds: [] }) })).status).toBe(403);
    // reativada: volta ao normal
    await setSub({ status: "active", currentPeriodEnd: new Date(Date.now() + 30 * day) });
    expect((await call(USER_S, "/agents")).status).toBe(200);
  });

  it("atendente (sem agent.manage) é barrado em todas as rotas", async () => {
    for (const [method, path] of [
      ["GET", "/agents"],
      ["POST", "/agents"],
      ["GET", "/agents/channels"],
      ["GET", "/agents/plan-usage"],
      ["GET", "/agents/x"],
      ["PUT", "/agents/x/config"],
      ["POST", "/agents/x/rollback"],
      ["POST", "/agents/x/status"],
      ["POST", "/agents/x/documents"],
      ["DELETE", "/agents/x/documents/y"],
      ["POST", "/agents/x/simulate"],
      ["GET", "/copilot"],
      ["PUT", "/copilot"],
    ] as const) {
      const res = await call("usr_rafael", path, { method, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe.skipIf(!ready)("Agentes: casos de uso e versionamento", () => {
  let agent: Agent;

  it("cria (primeiro vira padrão), edita => versão 2, rollback move o ponteiro, editar de novo => versão 3", async () => {
    const res = await createAgent("usr_marina", A, { name: "Duck teste", job: "support", channelIds: [] });
    expect(res.status).toBe(201);
    agent = await json<Agent>(res);
    expect(agent.currentVersion).toBe(1);
    expect(agent.status).toBe("inactive");

    const edited: AgentConfig = { ...agent.config, name: "Duck editado", advanced: { ...agent.config.advanced, tools: ["search_knowledge"] } };
    const put = await call("usr_marina", `/agents/${agent.id}/config`, { method: "PUT", body: JSON.stringify(edited) });
    expect(put.status).toBe(200);
    const v2 = await json<Agent>(put);
    expect(v2.currentVersion).toBe(2);
    expect(v2.config.advanced.tools).toContain("request_human"); // nunca pode ser desligada

    const versions = await json<{ id: string; number: number }[]>(await call("usr_marina", `/agents/${agent.id}/versions`));
    expect(versions.map((v) => v.number)).toEqual([2, 1]);
    const first = versions.find((v) => v.number === 1);
    const back = await call("usr_marina", `/agents/${agent.id}/rollback`, { method: "POST", body: JSON.stringify({ versionId: first?.id }) });
    expect((await json<Agent>(back)).currentVersion).toBe(1);

    const again = await call("usr_marina", `/agents/${agent.id}/config`, { method: "PUT", body: JSON.stringify({ ...edited, name: "Duck 3" }) });
    expect((await json<Agent>(again)).currentVersion).toBe(3);
    const all = await json<{ number: number }[]>(await call("usr_marina", `/agents/${agent.id}/versions`));
    expect(all.map((v) => v.number)).toEqual([3, 2, 1]); // histórico nunca é apagado
  });

  it("guarda o formulário do gerador (config.generator) por versão; configs antigas sem ele continuam válidas; limites valem", async () => {
    const res = await createAgent("usr_marina", A, { name: "Duck gerador", job: "support", channelIds: [] });
    expect(res.status).toBe(201);
    const fresh = await json<Agent>(res);
    expect(fresh.config.generator).toBeUndefined(); // versão 1 (como as de antes do campo)

    const generator = {
      purpose: "sales" as const,
      companyText: "A Nexora faz sites e sistemas sob medida para empresas pequenas.",
      customInstructions: "Ser cordial.",
      restrictions: "Nunca mencionar preços",
      hours: "Seg a sex, 9h às 18h",
    };
    const put = await call("usr_marina", `/agents/${fresh.id}/config`, { method: "PUT", body: JSON.stringify({ ...fresh.config, generator }) });
    expect(put.status).toBe(200);
    const v2 = await json<Agent>(put);
    expect(v2.config.generator).toEqual(generator);
    const got = await json<Agent>(await call("usr_marina", `/agents/${fresh.id}`));
    expect(got.config.generator).toEqual(generator);

    // mudar só o formulário gera versão com resumo próprio
    const only = await call("usr_marina", `/agents/${fresh.id}/config`, { method: "PUT", body: JSON.stringify({ ...v2.config, generator: { ...generator, hours: "Todos os dias" } }) });
    expect(only.status).toBe(200);
    const versions = await json<{ id: string; number: number; summary: string; config: AgentConfig }[]>(await call("usr_marina", `/agents/${fresh.id}/versions`));
    expect(versions[0]?.summary).toContain("formulário do gerador");
    expect(versions.find((v) => v.number === 1)?.config.generator).toBeUndefined();
    expect(versions.find((v) => v.number === 2)?.config.generator).toEqual(generator);

    // o simulador aceita a config com generator e responde normalmente
    const sim = await call("usr_marina", `/agents/${fresh.id}/simulate`, {
      method: "POST",
      body: JSON.stringify({ config: v2.config, history: [{ role: "customer", text: "Quero falar com um atendente" }] }),
    });
    expect(sim.status).toBe(200);

    // limites: companyText até 20 mil; finalidade inválida
    const tooLong = await call("usr_marina", `/agents/${fresh.id}/config`, { method: "PUT", body: JSON.stringify({ ...v2.config, generator: { ...generator, companyText: "x".repeat(20_001) } }) });
    expect(tooLong.status).toBe(422);
    const badPurpose = await call("usr_marina", `/agents/${fresh.id}/config`, { method: "PUT", body: JSON.stringify({ ...v2.config, generator: { ...generator, purpose: "vendas" } }) });
    expect(badPurpose.status).toBe(422);
    const okMax = await call("usr_marina", `/agents/${fresh.id}/config`, { method: "PUT", body: JSON.stringify({ ...v2.config, generator: { ...generator, companyText: "x".repeat(20_000) } }) });
    expect(okMax.status).toBe(200);
  });

  it("Informações da empresa e Restrições: PUT persiste por versão, rollback e simulador funcionam, resumo cita os campos, limites valem", async () => {
    const res = await createAgent("usr_marina", A, { name: "Duck info", job: "support", channelIds: [] });
    expect(res.status).toBe(201);
    const fresh = await json<Agent>(res);
    expect(fresh.config.knowledge.companyInfo).toBeUndefined();
    expect(fresh.config.advanced.restrictions).toBeUndefined();

    const companyInfo = "## Sobre a empresa\nClínica Casa Alvorada.\n\n## Perguntas frequentes\nP: Atendem Unimed?\nR: Atendemos Unimed.";
    const restrictions = "- Nunca falar de concorrentes.";
    const next: AgentConfig = { ...fresh.config, knowledge: { ...fresh.config.knowledge, companyInfo }, advanced: { ...fresh.config.advanced, restrictions } };
    const put = await call("usr_marina", `/agents/${fresh.id}/config`, { method: "PUT", body: JSON.stringify(next) });
    expect(put.status).toBe(200);
    const v2 = await json<Agent>(put);
    expect(v2.config.knowledge.companyInfo).toBe(companyInfo);
    expect(v2.config.advanced.restrictions).toBe(restrictions);
    expect((await json<Agent>(await call("usr_marina", `/agents/${fresh.id}`))).config.knowledge.companyInfo).toBe(companyInfo);

    const versions = await json<{ id: string; number: number; summary: string; config: AgentConfig }[]>(await call("usr_marina", `/agents/${fresh.id}/versions`));
    expect(versions.find((v) => v.number === 2)?.summary).toBe("Alterou informações da empresa, restrições");
    expect(versions.find((v) => v.number === 1)?.config.knowledge.companyInfo).toBeUndefined();

    const sim = await call("usr_marina", `/agents/${fresh.id}/simulate`, {
      method: "POST",
      body: JSON.stringify({ config: v2.config, history: [{ role: "customer", text: "Quero falar com um atendente" }] }),
    });
    expect(sim.status).toBe(200);

    const back = await call("usr_marina", `/agents/${fresh.id}/rollback`, { method: "POST", body: JSON.stringify({ versionId: versions.find((v) => v.number === 1)?.id }) });
    expect((await json<Agent>(back)).config.knowledge.companyInfo).toBeUndefined();

    const tooLong = await call("usr_marina", `/agents/${fresh.id}/config`, { method: "PUT", body: JSON.stringify({ ...next, knowledge: { ...next.knowledge, companyInfo: "x".repeat(12_001) } }) });
    expect(tooLong.status).toBe(422);
    const tooLongR = await call("usr_marina", `/agents/${fresh.id}/config`, { method: "PUT", body: JSON.stringify({ ...next, advanced: { ...next.advanced, restrictions: "x".repeat(3_001) } }) });
    expect(tooLongR.status).toBe(422);
    const okMax = await call("usr_marina", `/agents/${fresh.id}/config`, {
      method: "PUT",
      body: JSON.stringify({ ...next, knowledge: { ...next.knowledge, companyInfo: "x".repeat(12_000) }, advanced: { ...next.advanced, restrictions: "x".repeat(3_000) } }),
    });
    expect(okMax.status).toBe(200);
  });

  it("não ativa sem canal vinculado", async () => {
    const res = await call("usr_marina", `/agents/${agent.id}/status`, { method: "POST", body: JSON.stringify({ status: "active" }) });
    expect(res.status).toBe(409);
  });

  it("config.scheduling legado é aceito e guardado sem validar (nada apagado); a agenda vem dos tipos ativos da empresa", async () => {
    const legacy = { ...agent.config, scheduling: { canBook: true, appointmentTypeIds: [staffType, uuidv7()] } };
    const put = await call("usr_marina", `/agents/${agent.id}/config`, { method: "PUT", body: JSON.stringify(legacy) });
    expect(put.status).toBe(200); // antes: 422 por tipo "só a equipe"/inexistente
    expect((await json<Agent>(put)).config.scheduling).toEqual(legacy.scheduling);
  });

  it("simulador: agente com canBook=false oferece horários porque a empresa tem tipo ativo (só tipos da empresa, nunca o 'só a equipe')", async () => {
    const config: AgentConfig = {
      ...agent.config,
      scheduling: { canBook: false, appointmentTypeIds: [] },
      advanced: { ...agent.config.advanced, tools: ["search_knowledge", "request_human"] },
    };
    const res = await call("usr_marina", `/agents/${agent.id}/simulate`, {
      method: "POST",
      body: JSON.stringify({ config, history: [{ role: "customer", text: "Quero marcar um horário na sexta" }] }),
    });
    expect(res.status).toBe(200);
    const reply = await json<{ toolCalls: { tool: string; args: Record<string, string> }[] }>(res);
    const listed = reply.toolCalls.find((t) => t.tool === "list_available_slots");
    expect(listed).toBeDefined();
    expect(listed?.args.type_id).not.toBe(staffType);
    const companyTypes = await withOrg(db, A, (tx) => tx.select({ id: schema.appointmentTypes.id }).from(schema.appointmentTypes).where(eq(schema.appointmentTypes.active, true)));
    expect(companyTypes.map((t) => t.id)).toContain(listed?.args.type_id);
    // o simulador não grava nada de cliente
    expect(await withOrg(db, A, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.source, "ai_agent")))).toEqual([]);
  });

  it("simulador: empresa SEM tipos não tem ferramentas de agenda (mesmo com canBook=true no agente) e tipos de outra empresa não aparecem", async () => {
    const created = await createAgent(USER_B, B, { name: "Duck B", job: "support", channelIds: [] });
    expect(created.status).toBe(201);
    const b = await json<Agent>(created);
    const config: AgentConfig = { ...b.config, scheduling: { canBook: true, appointmentTypeIds: [normalType, staffType] }, advanced: { ...b.config.advanced, tools: ["list_available_slots", "book_appointment", "request_human"] } };
    const res = await call(USER_B, `/agents/${b.id}/simulate`, {
      method: "POST",
      body: JSON.stringify({ config, history: [{ role: "customer", text: "Quero marcar um horário na sexta" }] }),
    });
    expect(res.status).toBe(200);
    const reply = await json<{ toolCalls: { tool: string; args: Record<string, string> }[] }>(res);
    expect(reply.toolCalls.filter((t) => ["list_available_slots", "book_appointment", "reschedule_appointment"].includes(t.tool))).toEqual([]);
    expect(JSON.stringify(reply)).not.toContain(normalType);
    expect(JSON.stringify(reply)).not.toContain(staffType);
    await withOrg(db, B, (tx) => tx.delete(schema.agents).where(eq(schema.agents.id, b.id))); // não atrapalha os testes de limite de plano da empresa B
  });

  it("documento TXT com texto vira trechos pesquisáveis; sem texto falha com motivo; remover apaga os trechos", async () => {
    const ok = await call("usr_marina", `/agents/${agent.id}/documents`, {
      method: "POST",
      body: JSON.stringify({ name: "precos.txt", sizeBytes: 120, text: "Clareamento a laser: R$ 600,00.\n\nLimpeza dental: R$ 180,00." }),
    });
    expect(ok.status).toBe(201);
    const doc = await json<{ id: string; status: string }>(ok);
    expect(doc.status).toBe("ready");

    const hits = await createDbKnowledgePort(db).search({ organizationId: A, conversationId: "c", contactId: "k", agentId: agent.id }, "quanto custa o clareamento", 3);
    expect(hits.some((h) => h.text.includes("R$ 600,00"))).toBe(true);
    // outra empresa nunca enxerga o conhecimento deste agente
    const other = await createDbKnowledgePort(db).search({ organizationId: B, conversationId: "c", contactId: "k", agentId: agent.id }, "clareamento", 3);
    expect(other).toEqual([]);

    const noText = await call("usr_marina", `/agents/${agent.id}/documents`, { method: "POST", body: JSON.stringify({ name: "tabela.pdf", sizeBytes: 5000 }) });
    expect((await json<{ status: string; error: string }>(noText)).status).toBe("failed");
    expect((await call("usr_marina", `/agents/${agent.id}/documents`, { method: "POST", body: JSON.stringify({ name: "x.exe", sizeBytes: 5 }) })).status).toBe(422);

    expect((await call("usr_marina", `/agents/${agent.id}/documents/${doc.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await createDbKnowledgePort(db).search({ organizationId: A, conversationId: "c", contactId: "k", agentId: agent.id }, "clareamento", 3)).toEqual([]);
  });

  it("simulador responde sem provedor configurado e não grava nada de cliente", async () => {
    const res = await call("usr_marina", `/agents/${agent.id}/simulate`, {
      method: "POST",
      body: JSON.stringify({ config: agent.config, history: [{ role: "customer", text: "Quero falar com um atendente" }] }),
    });
    expect(res.status).toBe(200);
    const reply = await json<{ handoff: { reason: string } | null; intent: string }>(res);
    expect(reply.handoff).not.toBeNull();
    expect(reply.intent).toBe("human");
  });
});

describe.skipIf(!ready)("Agentes: isolamento entre empresas (404, não revela existência)", () => {
  it("outra empresa não vê, edita, simula, nem mexe nos documentos", async () => {
    const res = await createAgent("usr_marina", A, { name: "Só da A", job: "support", channelIds: [] });
    const mine = await json<Agent>(res);
    const body = JSON.stringify({ config: mine.config, history: [{ role: "customer", text: "oi" }] });
    for (const [method, path, payload] of [
      ["GET", `/agents/${mine.id}`, undefined],
      ["PUT", `/agents/${mine.id}/config`, JSON.stringify(mine.config)],
      ["GET", `/agents/${mine.id}/versions`, undefined],
      ["POST", `/agents/${mine.id}/rollback`, JSON.stringify({ versionId: uuidv7() })],
      ["POST", `/agents/${mine.id}/status`, JSON.stringify({ status: "paused" })],
      ["POST", `/agents/${mine.id}/documents`, JSON.stringify({ name: "a.txt", sizeBytes: 3, text: "abc" })],
      ["DELETE", `/agents/${mine.id}/documents/${uuidv7()}`, undefined],
      ["POST", `/agents/${mine.id}/simulate`, body],
    ] as const) {
      const r = await call(USER_B, path, { method, body: payload });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    const list = await json<Agent[]>(await call(USER_B, "/agents"));
    expect(list.map((a) => a.id)).not.toContain(mine.id);
  });

  it("canal de outra empresa não pode ser vinculado", async () => {
    const [channel] = await withOrg(db, B, (tx) => tx.select({ id: schema.channels.id }).from(schema.channels).limit(1));
    if (!channel) return; // sem canal de teste no seed de B
    const res = await createAgent("usr_marina", A, { name: "Canal alheio", job: "support", channelIds: [channel.id] });
    expect(res.status).toBe(422);
  });
});

describe.skipIf(!ready)("Agentes: limites de plano no backend", () => {
  it("Básico: 1 agente; o segundo é recusado (403 plan_limit)", async () => {
    const first = await createAgent(USER_B, B, { name: "Único", job: "support", channelIds: [] });
    expect(first.status).toBe(201);
    const second = await createAgent(USER_B, B, { name: "Segundo", job: "support", channelIds: [] });
    expect(second.status).toBe(403);
    expect((await json<{ error: { code: string } }>(second)).error.code).toBe("plan_limit");
    const usage = await json<{ agents: number; maxAgents: number }>(await call(USER_B, "/agents/plan-usage"));
    expect(usage).toEqual({ agents: 1, maxAgents: 1 });
  });

  it("Básico: Instagram (403 plan_feature) e Copiloto (403 plan_feature) bloqueados, com a mensagem do plano certo", async () => {
    const insta = await createAgent(USER_B, B, { name: "Insta", job: "instagram_dm", channelIds: [] });
    expect(insta.status).toBe(403);
    const body = await json<{ error: { code: string; message: string } }>(insta);
    expect(body.error.code).toBe("plan_feature");
    expect(body.error.message).not.toMatch(/Escala|Essencial/);
    const copilot = await call(USER_B, "/copilot", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(copilot.status).toBe(403);
    const overview = await json<{ enabled: boolean }>(await call(USER_B, "/copilot"));
    expect(overview.enabled).toBe(false);
  });

  it("Pro: Instagram liberado e agentes ilimitados; Copiloto só no Empresarial (403 plan_feature)", async () => {
    const insta = await createAgent("usr_marina", A, { name: "Insta", job: "instagram_dm", channelIds: [] });
    expect(insta.status).toBe(201);
    const copilot = await call("usr_marina", "/copilot", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(copilot.status).toBe(403);
    const msg = await json<{ error: { code: string; message: string } }>(copilot);
    expect(msg.error.code).toBe("plan_feature");
    expect(msg.error.message).toContain("Empresarial");
    const overview = await json<{ enabled: boolean }>(await call("usr_marina", "/copilot"));
    expect(overview.enabled).toBe(false);
    const usage = await json<{ maxAgents: number | null }>(await call("usr_marina", "/agents/plan-usage"));
    expect(usage.maxAgents).toBeNull();
  });
});
