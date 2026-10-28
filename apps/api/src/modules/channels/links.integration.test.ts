import { createDb, schema, withOrg } from "@duckzap/db";
import { eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePlan } from "../../lib/plan";
import { agentIdByTeam, channelIdsByAgent, channelIdsByTeam, dbLinks, setAgentChannels, setTeamAgent, setTeamChannels } from "./links";
import { isSendingPausedForOrg } from "./sending";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";

/**
 * INTEGRAÇÃO da consistência de dados: vínculo canal↔equipe/agente (única fonte: channels.team_id/agent_id),
 * FKs SET NULL, plano resolvido do banco e bloqueio de envio pelo status efetivo da assinatura.
 * Precisa da migration que traz `channels.team_id` como uuid com FK e `plans.monthly_token_limit`: sem ela o arquivo é pulado.
 * Rode SÓ no banco descartável (duckzap_scratch_all).
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}

const url = process.env.DATABASE_URL;
const { db, close } = createDb(url ?? "postgres://invalid/invalid", { max: 3 });
afterAll(close);

async function schemaReady() {
  if (!url) return false;
  try {
    const rows = await db.execute<{ ok: boolean }>(
      sql`select (
        exists (select 1 from information_schema.columns where table_name = 'channels' and column_name = 'team_id' and data_type = 'uuid')
        and exists (select 1 from information_schema.columns where table_name = 'plans' and column_name = 'monthly_token_limit')
        and not exists (select 1 from information_schema.columns where table_name = 'teams' and column_name = 'channel_ids')
      ) as ok`,
    );
    return Boolean(rows[0]?.ok);
  } catch {
    return false;
  }
}
const ready = (await schemaReady()) && Boolean(process.env.DATABASE_ADMIN_URL);

const A = "org_alvorada";
const B = "org_lume";
const run = randomBytes(3).toString("hex");
const hours = Array.from({ length: 7 }, (_, day) => ({ day, open: day >= 1 && day <= 5, start: "08:00", end: "18:00" }));
const created = { teams: [] as string[], agents: [] as string[], channels: [] as string[] };

async function newTeam(org: string, label: string, priority = 9) {
  const id = uuidv7();
  await withOrg(db, org, (tx) =>
    tx.insert(schema.teams).values({ id, organizationId: org, name: `lk-${run}-${label}`, color: "blue", priority, businessHours: hours }),
  );
  created.teams.push(id);
  return id;
}

async function newAgent(org: string, label: string) {
  const id = uuidv7();
  await withOrg(db, org, async (tx) => {
    await tx.insert(schema.agents).values({ id, organizationId: org, job: "support", currentVersion: 1 });
    await tx.insert(schema.agentVersions).values({
      id: uuidv7(),
      organizationId: org,
      agentId: id,
      number: 1,
      config: { name: `Agente ${label}` },
      summary: "teste",
      createdBy: "teste",
    });
  });
  created.agents.push(id);
  return id;
}

async function newChannel(org: string, label: string) {
  const id = uuidv7();
  await withOrg(db, org, (tx) =>
    tx.insert(schema.channels).values({
      id,
      organizationId: org,
      name: `lk-${run}-${label}`,
      type: "whatsapp_qr",
      provider: "evolution",
      status: "disconnected",
      webhookTokenHash: randomBytes(16).toString("hex"),
      webhookTokenEnc: "x",
    }),
  );
  created.channels.push(id);
  return id;
}

const channelRow = (org: string, id: string) =>
  withOrg(db, org, async (tx) => (await tx.select().from(schema.channels).where(eq(schema.channels.id, id)))[0]);

afterAll(async () => {
  if (!ready) return;
  for (const org of [A, B]) {
    await withOrg(db, org, async (tx) => {
      if (created.channels.length) await tx.delete(schema.channels).where(inArray(schema.channels.id, created.channels));
      if (created.teams.length) await tx.delete(schema.teams).where(inArray(schema.teams.id, created.teams));
      if (created.agents.length) await tx.delete(schema.agents).where(inArray(schema.agents.id, created.agents));
    });
  }
});

describe.skipIf(!ready)("vínculos canal ↔ equipe/agente (channels.team_id / channels.agent_id)", () => {
  it("setTeamChannels grava em channels.team_id, troca a lista e solta o que saiu", async () => {
    const team = await newTeam(A, "t1");
    const c1 = await newChannel(A, "c1");
    const c2 = await newChannel(A, "c2");
    expect(await withOrg(db, A, (tx) => setTeamChannels(tx, A, team, [c1, c2]))).toEqual({ ok: true });
    expect((await channelRow(A, c1))?.teamId).toBe(team);
    expect(await withOrg(db, A, (tx) => channelIdsByTeam(tx, A).then((m) => m.get(team)?.sort()))).toEqual([c1, c2].sort());
    await withOrg(db, A, (tx) => setTeamChannels(tx, A, team, [c2]));
    expect((await channelRow(A, c1))?.teamId).toBeNull();
    expect((await channelRow(A, c2))?.teamId).toBe(team);
  });

  it("recusa equipe, agente e canais de outra empresa (e ids malformados), sem gravar nada", async () => {
    const teamA = await newTeam(A, "iso-a");
    const teamB = await newTeam(B, "iso-b");
    const agentB = await newAgent(B, "iso-b");
    const channelA = await newChannel(A, "iso-ca");
    const channelB = await newChannel(B, "iso-cb");
    expect(await withOrg(db, A, (tx) => setTeamChannels(tx, A, teamB, [channelA]))).toEqual({ ok: false, code: "invalid_team" });
    expect(await withOrg(db, A, (tx) => setTeamChannels(tx, A, teamA, [channelB]))).toEqual({ ok: false, code: "invalid_channels" });
    expect(await withOrg(db, A, (tx) => setTeamChannels(tx, A, teamA, ["team_x"]))).toEqual({ ok: false, code: "invalid_channels" });
    expect(await withOrg(db, A, (tx) => setAgentChannels(tx, A, agentB, [channelA]))).toEqual({ ok: false, code: "invalid_agent" });
    expect(await withOrg(db, A, (tx) => setTeamAgent(tx, A, teamA, agentB))).toEqual({ ok: false, code: "invalid_agent" });
    expect((await channelRow(A, channelA))?.teamId).toBeNull();
    expect((await channelRow(B, channelB))?.teamId).toBeNull();
    expect(await withOrg(db, A, (tx) => dbLinks.teamExists(tx, A, teamB))).toBe(false);
    expect(await withOrg(db, A, (tx) => dbLinks.agentExists(tx, A, agentB))).toBe(false);
  });

  it("agente: um canal tem um agente; derivações de canais/agente da equipe", async () => {
    const team = await newTeam(A, "ag-team");
    const a1 = await newAgent(A, "um");
    const a2 = await newAgent(A, "dois");
    const c1 = await newChannel(A, "ag-c1");
    const c2 = await newChannel(A, "ag-c2");
    await withOrg(db, A, async (tx) => {
      await setTeamChannels(tx, A, team, [c1, c2]);
      await setAgentChannels(tx, A, a1, [c1, c2]);
    });
    expect((await channelRow(A, c1))?.agentId).toBe(a1);
    expect(await withOrg(db, A, (tx) => agentIdByTeam(tx, A).then((m) => m.get(team)))).toBe(a1);
    // o canal c2 passa para o agente 2 (tira do 1)
    await withOrg(db, A, (tx) => setAgentChannels(tx, A, a2, [c2]));
    expect((await channelRow(A, c2))?.agentId).toBe(a2);
    expect(await withOrg(db, A, (tx) => channelIdsByAgent(tx, A).then((m) => m.get(a1)))).toEqual([c1]);
    // agente da equipe: troca nos canais dela; null limpa
    await withOrg(db, A, (tx) => setTeamAgent(tx, A, team, a2));
    expect((await channelRow(A, c1))?.agentId).toBe(a2);
    await withOrg(db, A, (tx) => setTeamAgent(tx, A, team, null));
    expect((await channelRow(A, c1))?.agentId).toBeNull();
  });

  it("apagar equipe ou agente solta o vínculo no canal (FK ON DELETE SET NULL)", async () => {
    const team = await newTeam(A, "del-team");
    const agent = await newAgent(A, "del-agent");
    const channel = await newChannel(A, "del-c");
    await withOrg(db, A, async (tx) => {
      await setTeamChannels(tx, A, team, [channel]);
      await setAgentChannels(tx, A, agent, [channel]);
    });
    await withOrg(db, A, (tx) => tx.delete(schema.teams).where(eq(schema.teams.id, team)));
    await withOrg(db, A, (tx) => tx.delete(schema.agents).where(eq(schema.agents.id, agent)));
    const row = await channelRow(A, channel);
    expect(row?.teamId).toBeNull();
    expect(row?.agentId).toBeNull();
  });

  it("o banco recusa vínculo para equipe inexistente e cor de equipe fora do contrato", async () => {
    const channel = await newChannel(A, "fk-c");
    await expect(withOrg(db, A, (tx) => tx.update(schema.channels).set({ teamId: uuidv7() }).where(eq(schema.channels.id, channel)))).rejects.toThrow();
    await expect(
      withOrg(db, A, (tx) => tx.insert(schema.teams).values({ id: uuidv7(), organizationId: A, name: `lk-${run}-cor`, color: "ink", priority: 9, businessHours: hours })),
    ).rejects.toThrow();
  });
});

describe.skipIf(!ready)("plano resolvido do banco e bloqueio de envio pelo status efetivo", () => {
  // empresa PRÓPRIA: estes testes alteram a assinatura, o que suspenderia a org_alvorada (compartilhada) para os arquivos que rodam em paralelo
  let sub: SecondOrg;
  let S = "";
  beforeAll(async () => {
    sub = await createSecondOrg("assinatura");
    S = sub.orgId;
  });
  afterAll(async () => {
    await sub?.remove();
  });

  it("resolvePlan lê assinatura → plano (slug livre, limites e orçamento do banco)", async () => {
    const slug = `custom-${run}`;
    await db.insert(schema.plans).values({ slug, name: "Personalizado", maxChannels: 9, maxUsers: 4, maxAgents: null, monthlyTokenLimit: 123_456, features: ["campaigns"] });
    const [original] = await withOrg(db, S, (tx) => tx.select().from(schema.subscriptions));
    try {
      await withOrg(db, S, (tx) => tx.update(schema.subscriptions).set({ planSlug: slug }).where(eq(schema.subscriptions.organizationId, S)));
      const plan = await withOrg(db, S, (tx) => resolvePlan(tx, S));
      expect(plan).toMatchObject({ slug, limits: { channels: 9, users: 4, agents: null }, features: ["campaigns"], monthlyTokenLimit: 123_456 });
    } finally {
      if (original) await withOrg(db, S, (tx) => tx.update(schema.subscriptions).set({ planSlug: original.planSlug }).where(eq(schema.subscriptions.organizationId, S)));
      await db.delete(schema.plans).where(eq(schema.plans.slug, slug));
    }
  });

  it("isSendingPausedForOrg: 1 dia de tolerância, depois suspende; past_due guardado dentro da tolerância ainda envia", async () => {
    const [original] = await withOrg(db, S, (tx) => tx.select().from(schema.subscriptions));
    if (!original) throw new Error("empresa de teste sem assinatura");
    const due = new Date("2026-03-10T15:00:00Z");
    const day = (d: number) => new Date(`2026-03-${String(d).padStart(2, "0")}T15:00:00Z`);
    const paused = (now: Date) => withOrg(db, S, (tx) => isSendingPausedForOrg(tx, now));
    try {
      for (const [status, now, expected] of [
        ["active", day(5), false],
        ["active", day(11), false], // 1 dia de atraso: tolerância
        ["active", day(12), true], // 2 dias: suspensa
        ["past_due", day(11), false],
        ["past_due", day(25), true],
        ["canceled", day(5), true],
      ] as const) {
        await withOrg(db, S, (tx) =>
          tx.update(schema.subscriptions).set({ status, currentPeriodEnd: due, disabledAt: null }).where(eq(schema.subscriptions.organizationId, S)),
        );
        expect(await paused(now), `${status} ${now.toISOString()}`).toBe(expected);
      }
    } finally {
      await withOrg(db, S, (tx) =>
        tx
          .update(schema.subscriptions)
          .set({ status: original.status, currentPeriodEnd: original.currentPeriodEnd, disabledAt: original.disabledAt })
          .where(eq(schema.subscriptions.organizationId, S)),
      );
    }
  });
});
