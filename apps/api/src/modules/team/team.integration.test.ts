import { createFakeLlm } from "@duckzap/ai";
import { createDb, schema, withOrg } from "@duckzap/db";
import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Auth } from "../../auth";
import type { Env } from "../../env";
import type { Deps } from "../../lib/context";
import { findInvite, listMemberRows, listPendingInvites } from "./queries";
import { teamRoutes } from "./routes";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";

// INTEGRAÇÃO: usa o Postgres real (papel duckzap_app) e o seed de dev (org_alvorada). A "outra empresa" é uma empresa ATIVA criada aqui
// (a org_lume do seed está expirada = conta suspensa, 403 em tudo) e removida no fim; criar empresa usa DATABASE_ADMIN_URL.
// Depende das tabelas novas do módulo (member_profiles, teams, team_members, invite_profiles): só roda
// depois que a migration única for aplicada; antes disso o arquivo inteiro é pulado.
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
      sql`select (to_regclass('public.member_profiles') is not null and to_regclass('public.teams') is not null
        and to_regclass('public.team_members') is not null and to_regclass('public.invite_profiles') is not null) as ok`,
    );
    return Boolean(rows[0]?.ok);
  } catch {
    return false;
  }
}
const ready = (await tablesReady()) && Boolean(process.env.DATABASE_ADMIN_URL);

const A = "org_alvorada";
// "outra empresa": criada no beforeAll (plano Básico, ativa)
let B = "";
let OTHER_USER = "";
let other: SecondOrg | undefined;

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

/** Better Auth falso: a sessão vem do header `x-test-user`. Nada de rede e nada de cookie. */
const people: Record<string, { name: string; email: string; org: string }> = {
  usr_marina: { name: "Marina Alves", email: "marina@casaalvorada.com.br", org: A },
  usr_rafael: { name: "Rafael Costa", email: "rafael@casaalvorada.com.br", org: A },
};
beforeAll(async () => {
  if (!ready) return;
  other = await createSecondOrg("equipe", { ownerName: "Lia Moraes" });
  B = other.orgId;
  OTHER_USER = other.userId;
  people[OTHER_USER] = { name: other.userName, email: other.userEmail, org: B };
});
afterAll(async () => {
  await other?.remove();
});
const fakeAuth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get("x-test-user") ?? "";
      const p = people[id];
      if (!p) return null;
      return { session: { activeOrganizationId: p.org }, user: { id, name: p.name, email: p.email } };
    },
  },
};
// stub de teste: só `getSession` é usado nestes cenários
const deps = { env, db, auth: fakeAuth as unknown as Auth, llm: createFakeLlm() } satisfies Deps;
const app = teamRoutes(deps);
const call = (user: string, path: string, init: RequestInit = {}) => app.request(`http://x${path}`, { ...init, headers: { "x-test-user": user, "content-type": "application/json", ...init.headers } });

const hours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: day > 0 && day < 6, start: "08:00", end: "18:00" }));
const teamBody = (name: string) => ({
  name,
  color: "blue",
  priority: 3,
  businessHours: hours,
  greeting: "Oi",
  outOfHoursMessage: "Fechado",
  memberIds: ["usr_rafael"],
  channelIds: [],
  agentId: null,
});

describe.skipIf(!ready)("Equipe: isolamento entre empresas (member/invitation SEM RLS)", () => {
  it("lista só as pessoas da própria empresa", async () => {
    const a = await withOrg(db, A, (tx) => listMemberRows(tx, A));
    const b = await withOrg(db, B, (tx) => listMemberRows(tx, B));
    expect(a.map((m) => m.userId).sort()).toEqual(["usr_marina", "usr_rafael"]);
    expect(b.map((m) => m.userId)).toEqual([OTHER_USER]);
  });

  it("convite de outra empresa nunca aparece nem é encontrado", async () => {
    const marker = new Error("rollback");
    const invitationId = uuidv7();
    try {
      await withOrg(db, B, async (tx) => {
        await tx.insert(schema.invitation).values({
          id: invitationId,
          organizationId: B,
          email: "novo@studiolume.com.br",
          role: "member",
          status: "pending",
          expiresAt: new Date(Date.now() + 86_400_000),
          inviterId: OTHER_USER,
        });
        expect((await listPendingInvites(tx, B)).map((i) => i.id)).toContain(invitationId);
        expect((await listPendingInvites(tx, A)).map((i) => i.id)).not.toContain(invitationId);
        expect(await findInvite(tx, A, invitationId)).toBeNull();
        expect(await findInvite(tx, B, invitationId)).not.toBeNull();
        throw marker;
      });
    } catch (error) {
      if (error !== marker) throw error;
    }
  });
});

describe.skipIf(!ready)("Equipe: autorização nas rotas", () => {
  it("sem sessão: 401", async () => {
    const res = await app.request("http://x/team/overview");
    expect(res.status).toBe(401);
  });

  it("atendente (sem team.manage) é barrado em todas as rotas de Equipe", async () => {
    for (const [method, path] of [
      ["GET", "/team/overview"],
      ["POST", "/team/invites"],
      ["PATCH", "/team/members/usr_marina"],
      ["POST", "/team/members/usr_marina/deactivate"],
      ["POST", "/team/teams"],
      ["DELETE", "/team/teams/x"],
    ] as const) {
      const res = await call("usr_rafael", path, { method, body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("conta suspensa (org_lume está expirada): 403 account_suspended em Equipe, mesmo para a dona", async () => {
    people.usr_lume = { name: "Lia Moraes", email: "contato@studiolume.com.br", org: "org_lume" };
    for (const [method, path] of [["GET", "/team/overview"], ["POST", "/team/invites"], ["POST", "/team/teams"]] as const) {
      const res = await call("usr_lume", path, { method, body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("account_suspended");
    }
  });

  it("proprietária vê só a própria empresa", async () => {
    const res = await call("usr_marina", "/team/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: { id: string; email: string }[] };
    const ids = body.members.map((m) => m.id);
    expect(ids).toContain("usr_marina");
    expect(ids).not.toContain(OTHER_USER);
    expect(body.members.map((m) => m.email)).not.toContain(other?.userEmail);
  });

  it("não mexe em pessoa de outra empresa (404, sem revelar que existe)", async () => {
    const patch = await call("usr_marina", `/team/members/${OTHER_USER}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Invasora", role: "agent", teamIds: [] }),
    });
    expect(patch.status).toBe(404);
    const off = await call("usr_marina", `/team/members/${OTHER_USER}/deactivate`, { method: "POST" });
    expect(off.status).toBe(404);
    const reset = await call("usr_marina", `/team/members/${OTHER_USER}/password-reset`, { method: "POST" });
    expect(reset.status).toBe(404);
    const cancel = await call("usr_marina", `/team/invites/${uuidv7()}`, { method: "DELETE" });
    expect(cancel.status).toBe(404);
    const [lume] = await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, OTHER_USER));
    expect(lume?.name).toBe("Lia Moraes");
  });

  it("ninguém inativa a si mesmo e o último proprietário fica protegido", async () => {
    const res = await call("usr_marina", "/team/members/usr_marina/deactivate", { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("self");
    const demote = await call("usr_marina", "/team/members/usr_marina", {
      method: "PATCH",
      body: JSON.stringify({ name: "Marina Alves", role: "admin", teamIds: [] }),
    });
    expect(demote.status).toBe(409);
    expect(((await demote.json()) as { error: { code: string } }).error.code).toBe("last_owner");
  });
});

describe.skipIf(!ready)("Equipe: equipes (CRUD e tenant)", () => {
  it("cria, lista e apaga; outra empresa não enxerga nem altera", async () => {
    const name = `Teste ${uuidv7().slice(-6)}`;
    const created = await call("usr_marina", "/team/teams", { method: "POST", body: JSON.stringify(teamBody(name)) });
    expect(created.status).toBe(201);
    const team = (await created.json()) as { id: string; memberIds: string[] };
    try {
      expect(team.memberIds).toEqual(["usr_rafael"]);

      const dup = await call("usr_marina", "/team/teams", { method: "POST", body: JSON.stringify(teamBody(name.toUpperCase())) });
      expect(dup.status).toBe(409);

      // a outra empresa não vê, não altera e não apaga
      const lumeOverview = (await (await call(OTHER_USER, "/team/overview")).json()) as { teams: { id: string }[] };
      expect(lumeOverview.teams.map((t) => t.id)).not.toContain(team.id);
      const patch = await call(OTHER_USER, `/team/teams/${team.id}`, { method: "PATCH", body: JSON.stringify(teamBody("Invasora")) });
      expect(patch.status).toBe(404);
      const del = await call(OTHER_USER, `/team/teams/${team.id}`, { method: "DELETE" });
      expect(del.status).toBe(404);

      // pessoas de outra empresa não entram na equipe
      const foreign = await call("usr_marina", `/team/teams/${team.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...teamBody(name), memberIds: [OTHER_USER] }),
      });
      expect(foreign.status).toBe(422);

      // saudação e fora do horário são opcionais (a tela não os pede mais): ausentes na edição, o valor guardado é mantido
      const { greeting: _g, outOfHoursMessage: _o, ...withoutTexts } = teamBody(name);
      const edited = await call("usr_marina", `/team/teams/${team.id}`, { method: "PATCH", body: JSON.stringify({ ...withoutTexts, priority: 4 }) });
      expect(edited.status).toBe(200);
      expect(await edited.json()).toMatchObject({ priority: 4, greeting: "Oi", outOfHoursMessage: "Fechado" });
      // e ausentes na criação viram vazio
      const bare = await call("usr_marina", "/team/teams", { method: "POST", body: JSON.stringify({ ...withoutTexts, name: `${name} b`, memberIds: [] }) });
      expect(bare.status).toBe(201);
      const bareTeam = (await bare.json()) as { id: string; greeting: string; outOfHoursMessage: string };
      expect(bareTeam).toMatchObject({ greeting: "", outOfHoursMessage: "" });
      await withOrg(db, A, (tx) => tx.delete(schema.teams).where(eq(schema.teams.id, bareTeam.id)));
    } finally {
      await withOrg(db, A, (tx) => tx.delete(schema.teams).where(eq(schema.teams.id, team.id)));
    }
  });
});
