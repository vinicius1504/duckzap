import type { LinkOption } from "@duckzap/contracts/channels";
import { schema, type Transaction } from "@duckzap/db";
import { and, asc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";

/**
 * Vínculos canal↔equipe e canal↔agente. A ÚNICA fonte de verdade é `channels.team_id` / `channels.agent_id`
 * (FK com ON DELETE SET NULL). Equipe, Agentes e Canais gravam por aqui, na MESMA transação do chamador,
 * e as listas `channelIds`/`agentId` dos contratos são derivadas das leituras abaixo.
 *
 * Todas as funções recebem `organizationId` (vindo da sessão) e filtram por ele além da RLS.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const touch = () => ({ updatedAt: sql`now()` });

export interface LinkLookup {
  listTeams(tx: Transaction, organizationId: string): Promise<LinkOption[]>;
  listAgents(tx: Transaction, organizationId: string): Promise<LinkOption[]>;
  teamExists(tx: Transaction, organizationId: string, id: string): Promise<boolean>;
  agentExists(tx: Transaction, organizationId: string, id: string): Promise<boolean>;
}

/** Nome do agente = `config.name` da versão ativa. */
async function agentNames(tx: Transaction, organizationId: string, onlyId?: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await tx
    .select({ id: schema.agents.id, name: sql<string>`${schema.agentVersions.config}->>'name'` })
    .from(schema.agents)
    .innerJoin(
      schema.agentVersions,
      and(eq(schema.agentVersions.agentId, schema.agents.id), eq(schema.agentVersions.number, schema.agents.currentVersion)),
    )
    .where(and(eq(schema.agents.organizationId, organizationId), onlyId ? eq(schema.agents.id, onlyId) : undefined))
    .orderBy(asc(schema.agents.createdAt));
  return rows.map((r) => ({ id: r.id, name: r.name ?? "Agente" }));
}

export const dbLinks: LinkLookup = {
  async listTeams(tx, organizationId) {
    const rows = await tx
      .select({ id: schema.teams.id, name: schema.teams.name })
      .from(schema.teams)
      .where(eq(schema.teams.organizationId, organizationId))
      .orderBy(asc(schema.teams.priority), asc(schema.teams.name));
    return rows;
  },
  listAgents: (tx, organizationId) => agentNames(tx, organizationId),
  async teamExists(tx, organizationId, id) {
    if (!UUID_RE.test(id)) return false;
    const [row] = await tx
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(and(eq(schema.teams.organizationId, organizationId), eq(schema.teams.id, id)))
      .limit(1);
    return Boolean(row);
  },
  async agentExists(tx, organizationId, id) {
    if (!UUID_RE.test(id)) return false;
    const [row] = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.organizationId, organizationId), eq(schema.agents.id, id)))
      .limit(1);
    return Boolean(row);
  },
};

// --- leitura derivada ------------------------------------------------------------------------------------

/** Canais de cada equipe (mapa teamId → ids de canal), derivado de `channels.team_id`. */
export async function channelIdsByTeam(tx: Transaction, organizationId: string): Promise<Map<string, string[]>> {
  const rows = await tx
    .select({ id: schema.channels.id, teamId: schema.channels.teamId })
    .from(schema.channels)
    .where(and(eq(schema.channels.organizationId, organizationId), isNotNull(schema.channels.teamId)))
    .orderBy(asc(schema.channels.createdAt));
  const map = new Map<string, string[]>();
  for (const r of rows) if (r.teamId) map.set(r.teamId, [...(map.get(r.teamId) ?? []), r.id]);
  return map;
}

/**
 * Agente de cada equipe, derivado dos canais dela: o agente do primeiro canal (mais antigo) da equipe que tem agente.
 * Equipe sem canal com agente = null.
 */
export async function agentIdByTeam(tx: Transaction, organizationId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ teamId: schema.channels.teamId, agentId: schema.channels.agentId })
    .from(schema.channels)
    .where(and(eq(schema.channels.organizationId, organizationId), isNotNull(schema.channels.teamId), isNotNull(schema.channels.agentId)))
    .orderBy(asc(schema.channels.createdAt));
  const map = new Map<string, string>();
  for (const r of rows) if (r.teamId && r.agentId && !map.has(r.teamId)) map.set(r.teamId, r.agentId);
  return map;
}

/** Canais de cada agente (mapa agentId → ids de canal), derivado de `channels.agent_id`. */
export async function channelIdsByAgent(tx: Transaction, organizationId: string): Promise<Map<string, string[]>> {
  const rows = await tx
    .select({ id: schema.channels.id, agentId: schema.channels.agentId })
    .from(schema.channels)
    .where(and(eq(schema.channels.organizationId, organizationId), isNotNull(schema.channels.agentId)))
    .orderBy(asc(schema.channels.createdAt));
  const map = new Map<string, string[]>();
  for (const r of rows) if (r.agentId) map.set(r.agentId, [...(map.get(r.agentId) ?? []), r.id]);
  return map;
}

/** Nomes das equipes de cada agente (equipes dos canais dele). */
export async function teamNamesByAgent(tx: Transaction, organizationId: string): Promise<Map<string, string[]>> {
  const rows = await tx
    .select({ agentId: schema.channels.agentId, name: schema.teams.name })
    .from(schema.channels)
    .innerJoin(schema.teams, eq(schema.channels.teamId, schema.teams.id))
    .where(and(eq(schema.channels.organizationId, organizationId), isNotNull(schema.channels.agentId)))
    .orderBy(asc(schema.teams.priority));
  const map = new Map<string, string[]>();
  for (const r of rows) if (r.agentId && !(map.get(r.agentId) ?? []).includes(r.name)) map.set(r.agentId, [...(map.get(r.agentId) ?? []), r.name]);
  return map;
}

// --- escrita ---------------------------------------------------------------------------------------------

export type LinkResult = { ok: true } | { ok: false; code: "invalid_channels" | "invalid_team" | "invalid_agent" };

/** Todos os ids são canais DESTA empresa? (ids malformados contam como inexistentes.) */
async function channelsBelongToOrg(tx: Transaction, organizationId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  if (!ids.every((id) => UUID_RE.test(id))) return false;
  const rows = await tx
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(and(eq(schema.channels.organizationId, organizationId), inArray(schema.channels.id, ids)));
  return rows.length === ids.length;
}

/** Define os canais de uma equipe (a equipe precisa ser da empresa; os canais também). */
export async function setTeamChannels(tx: Transaction, organizationId: string, teamId: string, channelIds: string[]): Promise<LinkResult> {
  if (!(await dbLinks.teamExists(tx, organizationId, teamId))) return { ok: false, code: "invalid_team" };
  const ids = [...new Set(channelIds)];
  if (!(await channelsBelongToOrg(tx, organizationId, ids))) return { ok: false, code: "invalid_channels" };
  await tx
    .update(schema.channels)
    .set({ teamId: null, ...touch() })
    .where(
      and(
        eq(schema.channels.organizationId, organizationId),
        eq(schema.channels.teamId, teamId),
        ...(ids.length ? [notInArray(schema.channels.id, ids)] : []),
      ),
    );
  if (ids.length) {
    await tx
      .update(schema.channels)
      .set({ teamId, ...touch() })
      .where(and(eq(schema.channels.organizationId, organizationId), inArray(schema.channels.id, ids)));
  }
  return { ok: true };
}

/**
 * Define os canais de um agente. Um canal tem UM agente (`channels.agent_id`): canal listado aqui passa a ser deste
 * agente (tira de quem tinha); canal que era dele e não está na lista fica sem agente.
 */
export async function setAgentChannels(tx: Transaction, organizationId: string, agentId: string, channelIds: string[]): Promise<LinkResult> {
  if (!(await dbLinks.agentExists(tx, organizationId, agentId))) return { ok: false, code: "invalid_agent" };
  const ids = [...new Set(channelIds)];
  if (!(await channelsBelongToOrg(tx, organizationId, ids))) return { ok: false, code: "invalid_channels" };
  await tx
    .update(schema.channels)
    .set({ agentId: null, ...touch() })
    .where(
      and(
        eq(schema.channels.organizationId, organizationId),
        eq(schema.channels.agentId, agentId),
        ...(ids.length ? [notInArray(schema.channels.id, ids)] : []),
      ),
    );
  if (ids.length) {
    await tx
      .update(schema.channels)
      .set({ agentId, ...touch() })
      .where(and(eq(schema.channels.organizationId, organizationId), inArray(schema.channels.id, ids)));
  }
  return { ok: true };
}

/** Agente da equipe = agente dos canais dela (todos os canais da equipe passam a usar este agente; null limpa). */
export async function setTeamAgent(tx: Transaction, organizationId: string, teamId: string, agentId: string | null): Promise<LinkResult> {
  if (agentId !== null && !(await dbLinks.agentExists(tx, organizationId, agentId))) return { ok: false, code: "invalid_agent" };
  await tx
    .update(schema.channels)
    .set({ agentId, ...touch() })
    .where(and(eq(schema.channels.organizationId, organizationId), eq(schema.channels.teamId, teamId)));
  return { ok: true };
}
