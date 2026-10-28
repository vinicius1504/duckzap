import { createDb, schema, withOrg } from "@duckzap/db";
import { v7 as uuidv7 } from "uuid";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { Deps } from "../../lib/context";
import { registerInboundHandler, type InboundContext } from "../../lib/inbound";
import { decryptSecret } from "../../lib/crypto";
import type { OutboundMessage } from "../../lib/messaging";
import { onError } from "../../middleware/error-handler";
import { loadChannelsConfig } from "./config";
import { reprocessPending } from "./inbound-store";
import { EVOLUTION_WEBHOOK_HEADER } from "./providers/evolution";
import { META_SIGNATURE_HEADER } from "./providers/meta-cloud";
import { createProviderRegistry } from "./providers/registry";
import { hmacSha256Hex, type FetchLike } from "./providers/shared";
import { readCredentials, sealCredentials } from "./repo";
import { createChannelsRuntime } from "./runtime";
import { channelsRoutes } from "./routes";
import { sendViaChannel } from "./sending";
import * as service from "./service";
import { resolveChannelByToken } from "./webhook";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";

/**
 * INTEGRAÇÃO — precisa das tabelas `channels`, `inbound_events`, `channel_outbound` e das funções SQL de
 * `packages/db/src/schema/channels.sql.md` aplicadas, e do seed de dev (org_alvorada = Pro ativo; org_lume = Básico EXPIRADO, ou seja,
 * conta suspensa: só serve para testar suspensão). O "outro inquilino" dos testes é uma empresa ATIVA (plano Básico) criada aqui mesmo.
 * Roda como `duckzap_app` (sem BYPASSRLS): `DATABASE_URL` + `ENCRYPTION_KEY`; criar a 2ª empresa usa `DATABASE_ADMIN_URL`.
 * Sem eles, o arquivo é ignorado.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const url = process.env.DATABASE_URL;

// Empresa principal dos testes: um Pro (5 canais, com Instagram) PRÓPRIO deste arquivo. A org_alvorada do seed é compartilhada com os
// outros arquivos de integração, que rodam em paralelo e ocupam canais dela, o que estouraria o limite do plano aqui.
let ALVORADA = "";
const LUME = "org_lume"; // Básico com assinatura VENCIDA (conta suspensa)
const META_SECRET = "meta_app_secret_value_0123456789";
const run = Math.random().toString(36).slice(2, 8);
// prefixo PRÓPRIO deste arquivo: a limpeza abaixo não pode apagar canais "it-%" de outros arquivos que rodam em paralelo
const name = (label: string) => `itch-${run}-${label}`;

/** Evolution/Meta falsas, roteadas pelo host. */
function fakeProviders() {
  const state = { created: new Set<string>(), open: new Set<string>(), calls: [] as string[], sent: 0 };
  const fetch: FetchLike = async (input, init) => {
    const u = new URL(input);
    const path = u.pathname;
    state.calls.push(`${init?.method ?? "GET"} ${u.host}${path}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.host === "graph.test") {
      if (path.endsWith("/messages")) return json({ messages: [{ id: `wamid.${++state.sent}` }] });
      const token = new Headers(init?.headers).get("authorization");
      if (token?.includes("INVALIDO")) return json({ error: { code: 190 } }, 401);
      return json({ display_phone_number: "55 67 99900-1200", verified_name: "Casa" });
    }
    const instance = decodeURIComponent(path.split("/").pop() ?? "");
    if (path === "/instance/create") {
      const body = JSON.parse(String(init?.body)) as { instanceName: string };
      state.created.add(body.instanceName);
      return json({ hash: "INSTANCE-TOKEN-XYZ-0001", qrcode: { code: "2@QR-FIRST" } }, 201);
    }
    if (path.startsWith("/instance/connect/")) return state.created.has(instance) ? json({ code: "2@QR-AGAIN", count: 1 }) : json({}, 404);
    if (path.startsWith("/instance/connectionState/")) return json({ instance: { instanceName: instance, state: state.open.has(instance) ? "open" : "connecting" } });
    if (path.startsWith("/instance/fetchInstances")) return json([{ name: instance, ownerJid: "5567933331020@s.whatsapp.net" }]);
    if (path.startsWith("/instance/logout") || path.startsWith("/instance/delete")) return json({ status: "SUCCESS" });
    if (path.startsWith("/webhook/set/")) return json({ enabled: true });
    if (path.startsWith("/message/sendText/")) return json({ key: { id: `BAE5${++state.sent}` } }, 201);
    return json({}, 404);
  };
  return { state, fetch };
}

describe.skipIf(!url || !process.env.DATABASE_ADMIN_URL)("Canais — integração com Postgres (RLS, funções SQL, rotas)", () => {
  const { db, close } = createDb(url ?? "postgres://invalid", { max: 4 });
  const fake = fakeProviders();
  const config = loadChannelsConfig({
    EVOLUTION_URL: "http://evolution.test",
    EVOLUTION_API_KEY: "GLOBAL-KEY-0001",
    META_GRAPH_URL: "https://graph.test/v21.0",
    META_APP_SECRET: META_SECRET,
    PUBLIC_WEBHOOK_BASE_URL: "https://api.test",
    CHANNELS_SEND_BURST_QR: "2",
    CHANNELS_SEND_PER_SECOND_QR: "0.1",
  });
  const background: Promise<void>[] = [];
  const rt = createChannelsRuntime({
    config,
    providers: createProviderRegistry(config, { fetch: fake.fetch }),
    background: (task) => {
      background.push(task());
    },
  });

  // 2ª empresa ATIVA (Básico: 2 canais, sem Instagram), criada só para este arquivo
  let other: SecondOrg;
  let main: SecondOrg;
  let OTHER = "";
  beforeAll(async () => {
    other = await createSecondOrg("canais");
    OTHER = other.orgId;
    main = await createSecondOrg("canaispro", { planSlug: "pro", extra: [{ key: "agente", role: "member" }] });
    ALVORADA = main.orgId;
    sessions.owner = { user: { id: main.userId, name: main.userName, email: main.userEmail }, session: { id: "s1", activeOrganizationId: ALVORADA } };
    const agente = main.members.agente!;
    sessions.agent = { user: { id: agente.userId, name: agente.name, email: agente.email }, session: { id: "s2", activeOrganizationId: ALVORADA } };
    sessions.other = { user: { id: other.userId, name: other.userName, email: other.userEmail }, session: { id: "s4", activeOrganizationId: OTHER } };
  });

  // sessões falsas: o Better Auth real é coberto pelos testes de auth; aqui interessa papel e empresa
  const sessions: Record<string, unknown> = {
    lume: { user: { id: "usr_lume", name: "Lia", email: "contato@studiolume.com.br" }, session: { id: "s3", activeOrganizationId: LUME } },
  };
  const deps = {
    db,
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null } },
  } as unknown as Deps;
  const app = new OpenAPIHono();
  app.route("/v1", channelsRoutes(deps, rt));
  app.onError(onError);

  const call = (as: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`/v1${path}`, {
      method,
      headers: { ...(as ? { "x-test-user": as } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function create(as: "owner" | "other", label: string, type = "whatsapp_qr") {
    const res = await call(as, "POST", "/channels", { type, name: name(label) });
    const body = (await res.json()) as { id?: string; error?: { code: string } };
    return { res, body };
  }
  /** Equipe de teste numa empresa (a coluna de cor tem CHECK com os nomes do contrato). */
  async function insertTeam(org: string, label: string) {
    const id = uuidv7();
    const hours = Array.from({ length: 7 }, (_, day) => ({ day, open: day >= 1 && day <= 5, start: "08:00", end: "18:00" }));
    await withOrg(db, org, (tx) =>
      tx.insert(schema.teams).values({ id, organizationId: org, name: name(`team-${label}`), color: "blue", priority: 9, businessHours: hours }),
    );
    return id;
  }
  const cleanup = async () => {
    for (const org of [ALVORADA, OTHER, LUME].filter(Boolean)) await withOrg(db, org, (tx) => tx.delete(schema.channels).where(like(schema.channels.name, "itch-%")));
  };

  afterAll(async () => {
    for (const org of [ALVORADA, OTHER, LUME].filter(Boolean)) {
      await withOrg(db, org, (tx) => tx.delete(schema.channels).where(like(schema.channels.name, `itch-${run}-%`)));
    }
    await other?.remove();
    await main?.remove();
    await close();
  });

  // cada teste parte sem canais de teste (limites de plano são pequenos); também limpa restos de execuções interrompidas
  beforeEach(cleanup);

  describe("autenticação e autorização", () => {
    it("sem sessão: 401 em toda rota autenticada", async () => {
      for (const [method, path] of [["GET", "/channels"], ["POST", "/channels"], ["DELETE", "/channels/x"], ["GET", "/channels/x/qr"]] as const) {
        expect((await call(null, method, path, method === "POST" ? {} : undefined)).status, `${method} ${path}`).toBe(401);
      }
    });

    it("atendente (sem channel.manage): 403 em tudo", async () => {
      expect((await call("agent", "GET", "/channels")).status).toBe(403);
      expect((await call("agent", "POST", "/channels", { type: "whatsapp_qr", name: name("agente") })).status).toBe(403);
      expect((await call("agent", "POST", "/channels/assign-team", { teamId: "t", channelIds: [] })).status).toBe(403);
    });

    it("webhooks são públicos: sem sessão não dá 401, dá 404 para token desconhecido", async () => {
      const res = await app.request(`/v1/webhooks/wa/meta/dzwh_${"A".repeat(43)}`, { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
      const get = await app.request(`/v1/webhooks/wa/meta/dzwh_${"A".repeat(43)}?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`);
      expect(get.status).toBe(404);
    });

    it("outra empresa não enxerga nem altera canal alheio (404, sem revelar existência)", async () => {
      const { body } = await create("owner", "alvorada-iso");
      const id = body.id!;
      const otherList = (await (await call("other", "GET", "/channels")).json()) as { channels: { id: string }[] };
      expect(otherList.channels.map((c) => c.id)).not.toContain(id);
      const attempts: [string, string, unknown?][] = [
        ["GET", `/channels/${id}/qr`],
        ["POST", `/channels/${id}/qr`],
        ["GET", `/channels/${id}/official-webhook`],
        ["POST", `/channels/${id}/disconnect`],
        ["POST", `/channels/${id}/default`],
        ["POST", `/channels/${id}/rotate-webhook-token`],
        ["POST", `/channels/${id}/instagram/authorize`],
        ["POST", `/channels/${id}/official-credentials`, { phoneNumberId: "1".repeat(15), businessAccountId: "2".repeat(15), accessToken: "t".repeat(30) }],
        ["PATCH", `/channels/${id}`, { teamId: null, agentId: null, messages: { welcome: "", outOfHours: "", closing: "", rating: "" }, inactivityTransferMinutes: 10 }],
        ["DELETE", `/channels/${id}`],
      ];
      for (const [method, path, payload] of attempts) {
        expect((await call("other", method, path, payload)).status, `${method} ${path}`).toBe(404);
      }
      // continua intacto para o dono
      const ownerList = (await (await call("owner", "GET", "/channels")).json()) as { channels: { id: string }[] };
      expect(ownerList.channels.map((c) => c.id)).toContain(id);
    });

    it("id malformado é 404, não erro de banco", async () => {
      expect((await call("owner", "DELETE", "/channels/not-a-uuid")).status).toBe(404);
    });

    it("assign-team: vínculo vive em channels.team_id; equipe/canal de outra empresa é recusado", async () => {
      const teamA = await insertTeam(ALVORADA, "assign");
      const teamOther = await insertTeam(OTHER, "assign");
      const { body } = await create("owner", "assign");
      const foreignChannel = await create("other", "assign-other");
      const channelsOf = async () => ((await (await call("owner", "GET", "/channels")).json()) as { channels: { id: string; teamId: string | null }[] }).channels;

      // a outra empresa não mexe no canal da A (canal inexistente para ela) e a A não usa equipe da B
      expect((await call("other", "POST", "/channels/assign-team", { teamId: teamOther, channelIds: [body.id] })).status).toBe(422);
      expect((await call("owner", "POST", "/channels/assign-team", { teamId: teamOther, channelIds: [body.id] })).status).toBe(422);
      expect((await call("owner", "POST", "/channels/assign-team", { teamId: teamA, channelIds: [foreignChannel.body.id] })).status).toBe(422);
      expect((await channelsOf()).find((c) => c.id === body.id)?.teamId).toBeNull();

      expect((await call("owner", "POST", "/channels/assign-team", { teamId: teamA, channelIds: [body.id] })).status).toBe(200);
      expect((await channelsOf()).find((c) => c.id === body.id)?.teamId).toBe(teamA);
      expect((await call("owner", "POST", "/channels/assign-team", { teamId: teamA, channelIds: [] })).status).toBe(200);
      expect((await channelsOf()).find((c) => c.id === body.id)?.teamId).toBeNull();

      // apagar a equipe solta o vínculo (FK SET NULL)
      await call("owner", "POST", "/channels/assign-team", { teamId: teamA, channelIds: [body.id] });
      await withOrg(db, ALVORADA, (tx) => tx.delete(schema.teams).where(eq(schema.teams.id, teamA)));
      expect((await channelsOf()).find((c) => c.id === body.id)?.teamId).toBeNull();
      await withOrg(db, OTHER, (tx) => tx.delete(schema.teams).where(eq(schema.teams.id, teamOther)));
    });

    it("GET /channels devolve equipes REAIS da empresa (nunca as de outra)", async () => {
      const teamA = await insertTeam(ALVORADA, "lista");
      const teamOther = await insertTeam(OTHER, "lista");
      const overview = (await (await call("owner", "GET", "/channels")).json()) as { teams: { id: string }[]; agents: { id: string }[] };
      expect(overview.teams.map((t) => t.id)).toContain(teamA);
      expect(overview.teams.map((t) => t.id)).not.toContain(teamOther);
      await withOrg(db, ALVORADA, (tx) => tx.delete(schema.teams).where(eq(schema.teams.id, teamA)));
      await withOrg(db, OTHER, (tx) => tx.delete(schema.teams).where(eq(schema.teams.id, teamOther)));
    });
  });

  describe("criação, limites do plano e nomes", () => {
    it("valida entrada (422 com mensagem em pt-BR)", async () => {
      const res = await call("owner", "POST", "/channels", { type: "whatsapp_qr", name: "a" });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/nome/i);
    });

    it("Instagram só no plano com a feature (Básico → 403 type_not_allowed; Pro tem a feature)", async () => {
      const { res, body } = await create("other", "ig", "instagram");
      expect(res.status).toBe(403);
      expect(body.error?.code).toBe("type_not_allowed");
      const pro = await create("owner", "ig-pro", "instagram");
      expect(pro.res.status).toBe(200);
    });

    it("nome duplicado (sem diferenciar maiúsculas) → 409", async () => {
      const first = await create("other", "dup");
      expect(first.res.status).toBe(200);
      const res = await call("other", "POST", "/channels", { type: "whatsapp_qr", name: name("dup").toUpperCase() });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("duplicate_name");
    });

    it("limite do plano Básico (2): o terceiro canal é recusado no servidor", async () => {
      expect((await create("other", "l1")).res.status).toBe(200);
      expect((await create("other", "l2", "whatsapp_official")).res.status).toBe(200);
      const third = await create("other", "l3");
      expect(third.res.status).toBe(403);
      expect(third.body.error?.code).toBe("plan_limit");
      const overview = (await (await call("other", "GET", "/channels")).json()) as { limit: { used: number; max: number }; allowedTypes: string[] };
      expect(overview.limit).toEqual({ used: 2, max: 2 });
      expect(overview.allowedTypes).toEqual(["whatsapp_qr", "whatsapp_official"]);
    });

    it("criações simultâneas não furam o limite (trava por empresa)", async () => {
      const before = (await (await call("owner", "GET", "/channels")).json()) as { limit: { used: number; max: number } };
      const room = before.limit.max - before.limit.used;
      const attempts = await Promise.all(Array.from({ length: room + 3 }, (_, i) => create("owner", `race${i}`)));
      expect(attempts.filter((a) => a.res.status === 200)).toHaveLength(room);
      expect(attempts.filter((a) => a.body.error?.code === "plan_limit")).toHaveLength(3);
    });

    it("padrão: o primeiro WhatsApp vira padrão; trocar mantém um só; excluir o padrão com outros → 409", async () => {
      const a = await create("owner", "d1");
      const b = await create("owner", "d2", "whatsapp_official");
      const list = async () => ((await (await call("owner", "GET", "/channels")).json()) as { channels: { id: string; isDefault: boolean }[] }).channels;
      expect((await list()).filter((c) => c.isDefault).map((c) => c.id)).toEqual([a.body.id]);
      expect((await call("owner", "POST", `/channels/${b.body.id}/default`)).status).toBe(200);
      expect((await list()).filter((c) => c.isDefault).map((c) => c.id)).toEqual([b.body.id]);
      const del = await call("owner", "DELETE", `/channels/${b.body.id}`);
      expect(del.status).toBe(409);
      expect((await call("owner", "DELETE", `/channels/${a.body.id}`)).status).toBe(200);
    });

    it("configurações do canal: atualiza mensagens e transferência; resposta não traz segredo", async () => {
      const { body } = await create("owner", "cfg");
      const teamId = await insertTeam(ALVORADA, "cfg");
      const otherTeam = await insertTeam(OTHER, "cfg");
      // equipe de outra empresa e id inventado: 422, nada é gravado
      const foreign = await call("owner", "PATCH", `/channels/${body.id}`, {
        teamId: otherTeam,
        agentId: null,
        messages: { welcome: "", outOfHours: "", closing: "", rating: "" },
        inactivityTransferMinutes: 30,
      });
      expect(foreign.status).toBe(422);
      const invented = await call("owner", "PATCH", `/channels/${body.id}`, {
        teamId: "team_recepcao",
        agentId: "agt_duck",
        messages: { welcome: "", outOfHours: "", closing: "", rating: "" },
        inactivityTransferMinutes: 30,
      });
      expect(invented.status).toBe(422);
      const res = await call("owner", "PATCH", `/channels/${body.id}`, {
        teamId,
        agentId: null,
        messages: { welcome: "Olá!", outOfHours: "Fora do horário", closing: "Tchau", rating: "Nota?" },
        inactivityTransferMinutes: 60,
      });
      expect(res.status).toBe(200);
      const channel = (await res.json()) as Record<string, unknown>;
      expect(channel).toMatchObject({ teamId, inactivityTransferMinutes: 60, messages: { welcome: "Olá!" } });
      expect(Object.keys(channel).sort()).toEqual(["address", "agentId", "createdAt", "id", "inactivityTransferMinutes", "isDefault", "lastStatusChangeAt", "messages", "name", "replyMode", "signMessages", "status", "teamId", "type"]);
      const bad = await call("owner", "PATCH", `/channels/${body.id}`, { teamId: null, agentId: null, messages: { welcome: "", outOfHours: "", closing: "", rating: "" }, inactivityTransferMinutes: 15 });
      expect(bad.status).toBe(422);
      await withOrg(db, ALVORADA, (tx) => tx.delete(schema.teams).where(eq(schema.teams.id, teamId)));
      await withOrg(db, OTHER, (tx) => tx.delete(schema.teams).where(eq(schema.teams.id, otherTeam)));
    });

    it("modo de resposta: nasce em 'ai'; ida e volta preserva os textos; omitir mantém; valor inválido 422; atendente 403; outra empresa 404", async () => {
      const { body } = await create("owner", "modo");
      expect(body).toMatchObject({ replyMode: "ai" });
      const messages = { welcome: "Olá, bem-vindo!", outOfHours: "Voltamos amanhã.", closing: "", rating: "" };
      const base = { teamId: null, agentId: null, inactivityTransferMinutes: 30 as const };
      const auto = await call("owner", "PATCH", `/channels/${body.id}`, { ...base, replyMode: "auto", messages });
      expect(auto.status).toBe(200);
      expect(await auto.json()).toMatchObject({ replyMode: "auto", messages: { welcome: "Olá, bem-vindo!", outOfHours: "Voltamos amanhã." } });
      // omitir replyMode mantém o modo atual
      const kept = await call("owner", "PATCH", `/channels/${body.id}`, { ...base, messages });
      expect(await kept.json()).toMatchObject({ replyMode: "auto" });
      // voltar para Somente IA não apaga os textos
      const back = await call("owner", "PATCH", `/channels/${body.id}`, { ...base, replyMode: "ai", messages });
      expect(await back.json()).toMatchObject({ replyMode: "ai", messages: { welcome: "Olá, bem-vindo!", outOfHours: "Voltamos amanhã." } });
      const listed = (await (await call("owner", "GET", "/channels")).json()) as { channels: { id: string; replyMode: string; messages: { welcome: string } }[] };
      expect(listed.channels.find((c) => c.id === body.id)).toMatchObject({ replyMode: "ai", messages: { welcome: "Olá, bem-vindo!" } });
      expect((await call("owner", "PATCH", `/channels/${body.id}`, { ...base, replyMode: "ai_auto", messages })).status).toBe(422);
      expect((await call("agent", "PATCH", `/channels/${body.id}`, { ...base, replyMode: "auto", messages })).status).toBe(403);
      expect((await call("other", "PATCH", `/channels/${body.id}`, { ...base, replyMode: "auto", messages })).status).toBe(404);
      const row = await withOrg(db, ALVORADA, (tx) => tx.select({ mode: schema.channels.replyMode }).from(schema.channels).where(eq(schema.channels.id, body.id!)));
      expect(row[0]?.mode).toBe("ai");
    });

    it("excluir canal COM conversas é permitido: conversas ficam salvas sem canal; atendente recebe 403", async () => {
      const a = await create("owner", "del-a");
      const b = await create("owner", "del-b");
      const contactId = uuidv7();
      const conversationId = uuidv7();
      await withOrg(db, ALVORADA, async (tx) => {
        await tx.insert(schema.contacts).values({ id: contactId, organizationId: ALVORADA, name: `it-${run}-contato` });
        await tx.insert(schema.conversations).values({ id: conversationId, organizationId: ALVORADA, contactId, channelId: b.body.id! });
      });
      expect(a.res.status).toBe(200);
      expect((await call("agent", "DELETE", `/channels/${b.body.id}`)).status).toBe(403);
      const res = await call("owner", "DELETE", `/channels/${b.body.id}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, preservedConversations: 1 });
      const [kept] = await withOrg(db, ALVORADA, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)));
      expect(kept).toBeDefined();
      expect(kept?.channelId).toBeNull();
      await withOrg(db, ALVORADA, async (tx) => {
        await tx.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
        await tx.delete(schema.contacts).where(eq(schema.contacts.id, contactId));
      });
    });
  });

  describe("RLS e função de resolução do token", () => {
    it("sem tenant definido o papel do app não lê canais nem eventos", async () => {
      expect(await db.select().from(schema.channels)).toHaveLength(0);
      expect(await db.select().from(schema.inboundEvents)).toHaveLength(0);
    });

    it("dz_resolve_channel_by_token acha só pelo hash exato e devolve só ids", async () => {
      const { body } = await create("owner", "resolve");
      const row = await withOrg(db, ALVORADA, async (tx) => (await tx.select().from(schema.channels).where(eq(schema.channels.id, body.id!)))[0]!);
      const token = decryptSecret(ALVORADA, row.webhookTokenEnc);
      expect(await resolveChannelByToken(db, token)).toEqual({ organization_id: ALVORADA, channel_id: body.id, provider: "evolution" });
      expect(await resolveChannelByToken(db, `${token}x`)).toBeUndefined();
      expect(await resolveChannelByToken(db, row.webhookTokenHash)).toBeUndefined(); // o hash não serve de token
    });

    it("credenciais ficam cifradas e o token em claro não está no banco", async () => {
      const { body } = await create("owner", "cipher", "whatsapp_official");
      const raw = await withOrg(db, ALVORADA, (tx) => tx.execute<{ credentials_enc: string; webhook_token_hash: string }>(sql`select credentials_enc, webhook_token_hash from channels where id = ${body.id!}`));
      expect(raw[0]!.credentials_enc.startsWith("v2:")).toBe(true); // formato atual (v1 é só o legado, que continua sendo lido)
      expect(raw[0]!.credentials_enc).not.toContain("verifyToken");
    });
  });

  describe("API oficial (Meta)", () => {
    it("webhook-info, handshake GET e conexão com validação do token na Meta", async () => {
      const { body } = await create("owner", "meta", "whatsapp_official");
      const info = (await (await call("owner", "GET", `/channels/${body.id}/official-webhook`)).json()) as { webhookUrl: string; verifyToken: string };
      expect(info.webhookUrl).toMatch(/^https:\/\/api\.test\/v1\/webhooks\/wa\/meta\/dzwh_/);
      const path = new URL(info.webhookUrl).pathname.replace("/v1", "");

      const challenge = await call(null, "GET", `${path}?hub.mode=subscribe&hub.verify_token=${info.verifyToken}&hub.challenge=987654`);
      expect(challenge.status).toBe(200);
      expect(await challenge.text()).toBe("987654");
      expect((await call(null, "GET", `${path}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1`)).status).toBe(403);

      const accessToken = "EAAG-INVALIDO-TOKEN-0123456789";
      const refused = await call("owner", "POST", `/channels/${body.id}/official-credentials`, { phoneNumberId: "106540352242922", businessAccountId: "102290129340398", accessToken });
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("invalid_credentials");

      const good = "EAAG-TOKEN-VALIDO-0123456789-abcd";
      const connected = await call("owner", "POST", `/channels/${body.id}/official-credentials`, { phoneNumberId: "106540352242922", businessAccountId: "102290129340398", accessToken: good });
      expect(connected.status).toBe(200);
      expect(await connected.json()).toMatchObject({ status: "connected", address: "+5567999001200" });
      const stored = await withOrg(db, ALVORADA, async (tx) => (await tx.select().from(schema.channels).where(eq(schema.channels.id, body.id!)))[0]!);
      expect(stored.credentialsHint).toBe("abcd");
      expect(readCredentials(stored).accessToken).toBe(good);
      expect(stored.credentialsEnc).not.toContain(good);
    });

    it("webhook assinado da Meta é gravado uma vez, despachado ao handler e o reenvio é ignorado", async () => {
      const { body } = await create("owner", "meta-in", "whatsapp_official");
      await call("owner", "POST", `/channels/${body.id}/official-credentials`, { phoneNumberId: "106540352242922", businessAccountId: "102290129340398", accessToken: "EAAG-TOKEN-VALIDO-0123456789-abcd" });
      const info = (await (await call("owner", "GET", `/channels/${body.id}/official-webhook`)).json()) as { webhookUrl: string };
      const path = new URL(info.webhookUrl).pathname.replace("/v1", "");
      const payload = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: "1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "106540352242922" }, contacts: [{ profile: { name: "João" }, wa_id: "5567988887777" }], messages: [{ from: "5567988887777", id: `wamid.${run}.1`, timestamp: "1793052600", type: "text", text: { body: "oi" } }] } }] }],
      });
      const received: InboundContext[] = [];
      registerInboundHandler(async (context) => {
        if (context.channelId === body.id) received.push(context);
      });
      const signed = { [META_SIGNATURE_HEADER]: `sha256=${hmacSha256Hex(META_SECRET, payload)}` };

      const bad = await call(null, "POST", path, undefined, { [META_SIGNATURE_HEADER]: "sha256=00" });
      expect(bad.status).toBe(401);

      const first = await app.request(`/v1${path}`, { method: "POST", headers: { ...signed, "content-type": "application/json" }, body: payload });
      expect(await first.json()).toEqual({ ok: true, received: 1, duplicates: 0 });
      await Promise.all(background.splice(0));
      const second = await app.request(`/v1${path}`, { method: "POST", headers: { ...signed, "content-type": "application/json" }, body: payload });
      expect(await second.json()).toEqual({ ok: true, received: 0, duplicates: 1 });
      await Promise.all(background.splice(0));

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ organizationId: ALVORADA, event: { type: "message", from: "+5567988887777", text: "oi" } });
      const rows = await withOrg(db, ALVORADA, (tx) => tx.select().from(schema.inboundEvents).where(eq(schema.inboundEvents.channelId, body.id!)));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.processedAt).not.toBeNull();
    });

    it("assinatura válida de outro número (outro phone_number_id) não gera evento", async () => {
      const { body } = await create("owner", "meta-other", "whatsapp_official");
      await call("owner", "POST", `/channels/${body.id}/official-credentials`, { phoneNumberId: "106540352242922", businessAccountId: "102290129340398", accessToken: "EAAG-TOKEN-VALIDO-0123456789-abcd" });
      const info = (await (await call("owner", "GET", `/channels/${body.id}/official-webhook`)).json()) as { webhookUrl: string };
      const path = new URL(info.webhookUrl).pathname.replace("/v1", "");
      const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: "999" }, messages: [{ from: "5567988887777", id: "wamid.x", timestamp: "1793052600", type: "text", text: { body: "oi" } }] } }] }] });
      const res = await app.request(`/v1${path}`, { method: "POST", headers: { [META_SIGNATURE_HEADER]: `sha256=${hmacSha256Hex(META_SECRET, payload)}` }, body: payload });
      expect(await res.json()).toEqual({ ok: true, received: 0, duplicates: 0 });
    });
  });

  describe("QR Code (Evolution) e webhooks da Evolution", () => {
    it("fluxo: gerar QR → qrcode.updated renova → connection.update open conecta e descobre o número", async () => {
      const { body } = await create("owner", "qr");
      const start = (await (await call("owner", "POST", `/channels/${body.id}/qr`)).json()) as { status: string; payload: string };
      expect(start).toMatchObject({ status: "waiting", payload: "2@QR-FIRST" });

      const poll = (await (await call("owner", "GET", `/channels/${body.id}/qr`)).json()) as { status: string; payload: string };
      expect(poll).toMatchObject({ status: "waiting", payload: "2@QR-FIRST" });
      const stored = await withOrg(db, ALVORADA, async (tx) => (await tx.select().from(schema.channels).where(eq(schema.channels.id, body.id!)))[0]!);
      expect(stored.qrPayloadEnc).not.toContain("QR-FIRST");
      const creds = readCredentials(stored);
      expect(creds.instanceToken).toBe("INSTANCE-TOKEN-XYZ-0001");
      expect(stored.credentialsHint).toBe("0001");

      const token = decryptSecret(ALVORADA, stored.webhookTokenEnc);
      const hook = (event: object, secret = creds.webhookSecret!) =>
        app.request(`/v1/webhooks/wa/evolution/${token}`, { method: "POST", headers: { [EVOLUTION_WEBHOOK_HEADER]: secret, "content-type": "application/json" }, body: JSON.stringify({ instance: creds.instanceName, date_time: "2026-10-26T22:00:00.000Z", ...event }) });

      expect((await hook({ event: "qrcode.updated", data: { qrcode: { code: "2@QR-NEW" } } }, "errado")).status).toBe(401);
      expect((await hook({ event: "qrcode.updated", data: { qrcode: { code: "2@QR-NEW" } } })).status).toBe(200);
      await Promise.all(background.splice(0));
      expect(await (await call("owner", "GET", `/channels/${body.id}/qr`)).json()).toMatchObject({ status: "waiting", payload: "2@QR-NEW" });

      fake.state.open.add(creds.instanceName!);
      expect((await hook({ event: "connection.update", data: { instance: creds.instanceName, state: "open", statusReason: 200 } })).status).toBe(200);
      await Promise.all(background.splice(0));
      const channel = (await (await call("owner", "GET", "/channels")).json()) as { channels: { id: string; status: string; address: string | null }[] };
      expect(channel.channels.find((c) => c.id === body.id)).toMatchObject({ status: "connected", address: "+5567933331020" });
      expect(await (await call("owner", "GET", `/channels/${body.id}/qr`)).json()).toMatchObject({ status: "connected" });
    });

    it("desconectar derruba a sessão no provedor (logout + remoção da instância)", async () => {
      const { body } = await create("owner", "disc");
      await call("owner", "POST", `/channels/${body.id}/qr`);
      const res = await call("owner", "POST", `/channels/${body.id}/disconnect`);
      expect(await res.json()).toMatchObject({ status: "disconnected" });
      expect(fake.state.calls.some((c) => c.startsWith("DELETE evolution.test/instance/logout/"))).toBe(true);
    });

    it("rotacionar o token: o antigo para de valer, o novo vale, e a Evolution é reapontada", async () => {
      const { body } = await create("owner", "rotate");
      await call("owner", "POST", `/channels/${body.id}/qr`);
      const row = await withOrg(db, ALVORADA, async (tx) => (await tx.select().from(schema.channels).where(eq(schema.channels.id, body.id!)))[0]!);
      const oldToken = decryptSecret(ALVORADA, row.webhookTokenEnc);
      const res = await call("owner", "POST", `/channels/${body.id}/rotate-webhook-token`);
      expect(await res.json()).toEqual({ webhookUrl: null });
      const after = await withOrg(db, ALVORADA, async (tx) => (await tx.select().from(schema.channels).where(eq(schema.channels.id, body.id!)))[0]!);
      const newToken = decryptSecret(ALVORADA, after.webhookTokenEnc);
      expect(newToken).not.toBe(oldToken);
      expect(await resolveChannelByToken(db, oldToken)).toBeUndefined();
      expect(await resolveChannelByToken(db, newToken)).toMatchObject({ channel_id: body.id });
      expect(fake.state.calls.some((c) => c.startsWith("POST evolution.test/webhook/set/"))).toBe(true);
    });
  });

  describe("processamento de eventos: falha não perde o evento", () => {
    it("handler que falha deixa o evento pendente com erro; reprocessPending conclui", async () => {
      const { body } = await create("owner", "retry");
      const row = await withOrg(db, ALVORADA, async (tx) => (await tx.select().from(schema.channels).where(eq(schema.channels.id, body.id!)))[0]!);
      await call("owner", "POST", `/channels/${body.id}/qr`);
      const stored = await withOrg(db, ALVORADA, async (tx) => (await tx.select().from(schema.channels).where(eq(schema.channels.id, body.id!)))[0]!);
      const creds = readCredentials(stored);
      const token = decryptSecret(ALVORADA, row.webhookTokenEnc);

      let failing = true;
      const seen: string[] = [];
      registerInboundHandler(async (context) => {
        if (context.channelId !== body.id) return;
        if (failing) throw new Error("conversas fora do ar");
        seen.push(context.event.type);
      });
      const payload = { event: "messages.upsert", instance: creds.instanceName, data: { key: { remoteJid: "5567999990000@s.whatsapp.net", fromMe: false, id: `E${run}` }, message: { conversation: "oi" }, messageTimestamp: 1793052600 } };
      const res = await app.request(`/v1/webhooks/wa/evolution/${token}`, { method: "POST", headers: { [EVOLUTION_WEBHOOK_HEADER]: creds.webhookSecret! }, body: JSON.stringify(payload) });
      expect(res.status).toBe(200); // o provedor recebe 200 mesmo com o downstream fora
      await Promise.all(background.splice(0));

      const pending = await withOrg(db, ALVORADA, (tx) => tx.select().from(schema.inboundEvents).where(eq(schema.inboundEvents.channelId, body.id!)));
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ processedAt: null, attempts: 1 });
      expect(pending[0]!.error).toMatch(/conversas fora do ar/);
      expect(pending[0]!.nextAttemptAt).not.toBeNull();

      // ainda dentro do backoff: a varredura não mexe
      expect((await reprocessPending(db, rt)).processed).toBe(0);
      await withOrg(db, ALVORADA, (tx) => tx.update(schema.inboundEvents).set({ nextAttemptAt: null }).where(eq(schema.inboundEvents.channelId, body.id!)));
      failing = false;
      const result = await reprocessPending(db, rt);
      expect(result.processed).toBeGreaterThanOrEqual(1);
      expect(seen).toEqual(["message"]);
      const done = await withOrg(db, ALVORADA, (tx) => tx.select().from(schema.inboundEvents).where(eq(schema.inboundEvents.channelId, body.id!)));
      expect(done[0]).toMatchObject({ error: null, attempts: 2 });
      expect(done[0]!.processedAt).not.toBeNull();
    });
  });

  describe("sendViaChannel", () => {
    async function connectedChannel(label: string, org = ALVORADA, as: "owner" | "other" = "owner") {
      const { body } = await create(as, label);
      await withOrg(db, org, (tx) => tx.update(schema.channels).set({ status: "connected" }).where(eq(schema.channels.id, body.id!)));
      await withOrg(db, org, async (tx) => {
        const [row] = await tx.select().from(schema.channels).where(eq(schema.channels.id, body.id!));
        await tx
          .update(schema.channels)
          .set({ credentialsEnc: sealCredentials(org, { ...readCredentials(row!), instanceToken: "TOK-0001" }) })
          .where(eq(schema.channels.id, body.id!));
      });
      return body.id!;
    }
    const message = (externalId: string): OutboundMessage => ({ externalId, to: "+5567999990000", kind: "text", text: "Olá" });

    it("envia, é idempotente por externalId e respeita o rate limit do canal", async () => {
      const id = await connectedChannel("send");
      const before = fake.state.sent;
      const first = await withOrg(db, ALVORADA, (tx) => sendViaChannel(tx, id, message("m-1"), rt));
      expect(first.ok).toBe(true);
      const again = await withOrg(db, ALVORADA, (tx) => sendViaChannel(tx, id, message("m-1"), rt));
      expect(again).toEqual(first);
      expect(fake.state.sent).toBe(before + 1); // o provedor só foi chamado uma vez

      const second = await withOrg(db, ALVORADA, (tx) => sendViaChannel(tx, id, message("m-2"), rt));
      expect(second.ok).toBe(true);
      // balde de 2 fichas (config do teste): o terceiro envio distinto é limitado e NÃO fica reservado
      const limited = await withOrg(db, ALVORADA, (tx) => sendViaChannel(tx, id, message("m-3"), rt));
      expect(limited).toMatchObject({ ok: false, code: "rate_limited" });
      const rows = await withOrg(db, ALVORADA, (tx) => tx.select().from(schema.channelOutbound).where(eq(schema.channelOutbound.channelId, id)));
      expect(rows.map((r) => [r.externalId, r.status]).sort()).toEqual([["m-1", "sent"], ["m-2", "sent"]]);
    });

    it("não envia por canal de outra empresa nem por canal desconectado", async () => {
      const id = await connectedChannel("send-iso");
      const foreign = await withOrg(db, OTHER, (tx) => sendViaChannel(tx, id, message("x-1"), rt));
      expect(foreign).toMatchObject({ ok: false, code: "rejected" });
      await withOrg(db, ALVORADA, (tx) => tx.update(schema.channels).set({ status: "disconnected" }).where(eq(schema.channels.id, id)));
      expect(await withOrg(db, ALVORADA, (tx) => sendViaChannel(tx, id, message("x-2"), rt))).toMatchObject({ ok: false, code: "disconnected" });
    });

    it("plano expirado bloqueia o envio no servidor (org_lume está vencida)", async () => {
      // conta suspensa não cria canal pela API (403): o canal conectado é inserido direto, como se tivesse sido criado antes do vencimento
      const id = uuidv7();
      await withOrg(db, LUME, (tx) =>
        tx.insert(schema.channels).values({
          id,
          organizationId: LUME,
          name: name("send-expired"),
          type: "whatsapp_qr",
          provider: "evolution",
          status: "connected",
          webhookTokenHash: `hash-${run}-${id}`,
          webhookTokenEnc: "enc",
          credentialsEnc: sealCredentials(LUME, { instanceToken: "TOK-0001", instanceName: "x" }),
        }),
      );
      const creation = await call("lume", "POST", "/channels", { type: "whatsapp_qr", name: name("send-expired-api") });
      expect(creation.status).toBe(403);
      expect(((await creation.json()) as { error: { code: string } }).error.code).toBe("account_suspended");
      const result = await withOrg(db, LUME, (tx) => sendViaChannel(tx, id, message("p-1"), rt));
      expect(result).toMatchObject({ ok: false, code: "plan_paused" });
    });

    it("recusa mídia com URL interna (anti-SSRF) e mensagem inválida", async () => {
      const id = await connectedChannel("send-ssrf");
      const ssrf = await withOrg(db, ALVORADA, (tx) => sendViaChannel(tx, id, { externalId: "s-1", to: "+5567999990000", kind: "image", mediaUrl: "https://169.254.169.254/latest" }, rt));
      expect(ssrf).toMatchObject({ ok: false, code: "rejected" });
      const empty = await withOrg(db, ALVORADA, (tx) => sendViaChannel(tx, id, { externalId: "s-2", to: "+5567999990000", kind: "text" }, rt));
      expect(empty).toMatchObject({ ok: false, code: "rejected" });
    });
  });

  describe("Instagram (simulado)", () => {
    it("fluxo awaiting_authorization → connected → disconnect volta a awaiting_authorization", async () => {
      // o plano Pro já inclui a feature `instagram` (fonte única: tabela `plans`)
      const ctx = { organizationId: ALVORADA };
      const res = await service.createChannel(db, ctx, { type: "instagram", name: name("ig-ok") });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data).toMatchObject({ status: "awaiting_authorization", isDefault: false });
      const authorized = await service.authorizeInstagram(db, ctx, res.data.id);
      expect(authorized).toMatchObject({ ok: true, data: { status: "connected" } });
      const disc = await service.disconnectChannel(db, ctx, rt, res.data.id);
      expect(disc).toMatchObject({ ok: true, data: { status: "awaiting_authorization", address: null } });
      expect(await service.setDefaultChannel(db, ctx, res.data.id)).toMatchObject({ ok: false, code: "not_whatsapp" });
    });
  });
});
