import type { MemberRole, Session } from "@duckzap/contracts/session";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Deps } from "../../lib/context";

// Autorização das rotas de Clientes e Agenda sem banco: a sessão é simulada (buildSession) e as barreiras
// (401, 403 por papel/plano, 404 de id inválido, 422) rodam ANTES de qualquer acesso a dados.

const state = vi.hoisted(() => ({ session: null as unknown, authenticated: true }));

vi.mock("../session/queries", () => ({
  buildSession: async () => ({ ok: true, session: state.session }),
}));

import { appointmentsRoutes } from "../appointments/routes";
import { contactsRoutes, WHATSAPP_PREVIEWS_PER_MINUTE } from "./routes";

function sessionFor(role: MemberRole, status: Session["organization"]["subscriptionStatus"] = "active"): Session {
  return {
    user: { id: "user_1", name: "Pessoa", email: "pessoa@exemplo.com", role },
    organization: { id: "org_a", name: "Casa Alvorada", plan: "pro", subscriptionStatus: status, timeZone: "America/Sao_Paulo", features: ["campaigns", "instagram"], maxAgents: null },
  };
}

const deps = {
  auth: { api: { getSession: async () => (state.authenticated ? { session: { activeOrganizationId: "org_a" }, user: { id: "user_1" } } : null) } },
  // qualquer acesso ao banco nestes testes é um bug: as barreiras precisam responder antes
  db: new Proxy({}, { get: () => { throw new Error("acessou o banco"); } }),
} as unknown as Deps;

const app = new Hono();
app.route("/v1", contactsRoutes(deps));
app.route("/v1", appointmentsRoutes(deps));

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined || method === "GET" ? {} : { body: JSON.stringify(body) }),
  });

const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;
const ID = "0190b3a0-0000-7000-8000-000000000001";

beforeEach(() => {
  state.authenticated = true;
  state.session = sessionFor("owner");
});

describe("sem sessão", () => {
  it.each([
    ["GET", "/contacts"],
    ["POST", "/contacts"],
    ["GET", "/tags"],
    ["GET", "/appointments?from=2025-06-01&to=2025-06-30"],
    ["POST", "/appointments"],
    ["GET", "/agenda/owners"],
  ])("%s %s → 401", async (method, path) => {
    state.authenticated = false;
    const res = await call(method, path, {});
    expect(res.status).toBe(401);
  });
});

describe("atendente (sem permissões de gestão) é barrado com 403", () => {
  const forbidden: [string, string, unknown?][] = [
    ["POST", "/contacts/bulk/delete", { contactIds: [ID] }], // contact.delete
    ["POST", "/contacts/bulk/tag", { contactIds: [ID], tagId: ID }], // contact.bulk
    ["POST", "/contacts/bulk/list", { contactIds: [ID], listId: ID }],
    ["POST", "/contacts/import/preview"], // contact.import
    ["POST", "/contacts/import/commit", {}],
    ["POST", "/contacts/import/whatsapp/preview", { channelId: ID }], // contact.import
    ["POST", "/contacts/import/whatsapp/commit", {}],
    ["POST", "/contacts/export", { contactIds: null, filter: null }], // contact.export
    ["POST", "/contacts/invites", { contactIds: [ID], channelId: "ch" }], // campaign.send
    ["POST", "/tags", { name: "x", description: "", color: "ink" }], // contact.bulk
    ["PUT", "/tags/order", { orderedIds: [] }],
    ["PATCH", `/tags/${ID}`, { name: "x", description: "", color: "ink" }],
    ["DELETE", `/tags/${ID}`],
    ["POST", "/contact-lists", { name: "x", description: "", kind: "static", filter: null }],
    ["DELETE", `/contact-lists/${ID}`],
    ["POST", "/appointment-types", { name: "Consulta", durationMinutes: 30 }], // settings.manage
    ["PATCH", `/appointment-types/${ID}`, { active: false }],
    ["PUT", "/agenda/reminder-settings", { reminders: [], confirmByReply: true }],
    ["PUT", "/agenda/calendar-sync/connection", { connected: true }], // integration.manage
  ];
  it.each(forbidden)("%s %s", async (method, path, body) => {
    state.session = sessionFor("agent");
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("forbidden");
  });

  it("o atendente pode editar contato e gerir agenda: passa da autorização (cai na validação 422, sem tocar o banco)", async () => {
    state.session = sessionFor("agent");
    expect((await call("POST", "/contacts", {})).status).toBe(422); // contact.edit
    expect((await call("POST", "/appointments", {})).status).toBe(422); // appointment.manage
    expect((await call("POST", `/appointments/${ID}/status`, { status: "voando" })).status).toBe(422);
  });
});

describe("papéis com permissão passam da barreira", () => {
  it("administrador: excluir, importar e exportar chegam à validação", async () => {
    state.session = sessionFor("admin");
    expect((await call("POST", "/contacts/bulk/delete", {})).status).toBe(422);
    expect((await call("POST", "/contacts/import/commit", {})).status).toBe(422);
    expect((await call("POST", "/contacts/import/whatsapp/preview", {})).status).toBe(422);
    expect((await call("POST", "/contacts/import/whatsapp/commit", {})).status).toBe(422);
    expect((await call("POST", "/contacts/export", {})).status).toBe(422);
    expect((await call("PUT", "/agenda/reminder-settings", {})).status).toBe(422);
  });
});

describe("conta suspensa = bloqueio total; past_due na tolerância ainda envia", () => {
  it.each(["expired", "canceled"] as const)("%s: convite E leitura dão 403 account_suspended (middleware, antes de qualquer dado)", async (status) => {
    state.session = sessionFor("owner", status);
    for (const [method, path, body] of [
      ["POST", "/contacts/invites", { contactIds: [ID], channelId: "ch" }],
      ["GET", "/contacts"],
      ["GET", "/tags"],
      ["GET", "/appointments?from=2025-06-01&to=2025-06-30"],
      ["POST", "/contacts", {}],
    ] as const) {
      const res = await call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await errorOf(res)).code, `${method} ${path}`).toBe("account_suspended");
    }
  });

  it("past_due (dentro da tolerância de 1 dia): o convite NÃO é barrado (chega à validação 422, não 403)", async () => {
    state.session = sessionFor("owner", "past_due");
    const res = await call("POST", "/contacts/invites", {});
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).not.toBe("sending_paused");
    expect((await call("POST", "/contacts", {})).status).toBe(422);
  });

  it("atendente em conta suspensa também recebe account_suspended (a suspensão vem antes da permissão)", async () => {
    state.session = sessionFor("agent", "expired");
    const res = await call("POST", "/contacts/bulk/delete", { contactIds: [ID] });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("account_suspended");
  });
});

describe("importar do WhatsApp: limite de taxa (chamada pesada ao provedor)", () => {
  const preview = (routes: Hono) => routes.request("/v1/contacts/import/whatsapp/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channelId: ID }) });

  it("limiter negando → 429 rate_limited antes de qualquer dado", async () => {
    const routes = new Hono();
    routes.route("/v1", contactsRoutes(deps, undefined, { whatsappPreviewLimiter: { take: async () => ({ allowed: false, retryAfterMs: 30_000 }) } }));
    const res = await preview(routes);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: "rate_limited", retryAfterSeconds: 30 } });
  });

  it("padrão: 6 por minuto por empresa; a sétima é barrada (as anteriores chegam ao banco, que aqui é proibido)", async () => {
    const routes = new Hono();
    routes.route("/v1", contactsRoutes(deps));
    for (let i = 0; i < WHATSAPP_PREVIEWS_PER_MINUTE; i++) expect((await preview(routes)).status).toBe(500);
    expect((await preview(routes)).status).toBe(429);
  });
});

describe("entrada inválida", () => {
  it("id que não é UUID é 'não existe' (404), nunca erro de SQL", async () => {
    expect((await call("GET", "/contacts/abc")).status).toBe(404);
    expect((await call("PATCH", "/contacts/abc", {})).status).toBe(404);
    expect((await call("GET", "/appointments/abc")).status).toBe(404);
    expect((await call("DELETE", "/tags/1; drop table tags")).status).toBe(404);
  });

  it("confirmação da importação precisa ser exatamente true (z.literal)", async () => {
    const res = await call("POST", "/contacts/import/commit", {
      importId: ID,
      mapping: { c1: "name", c2: "phone" },
      origin: "form",
      originNote: "",
      confirmedRelationship: false,
      tagIds: [],
      listId: null,
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toMatch(/Confirme/);
  });

  it("origem 'inbound' não pode ser declarada na importação", async () => {
    const res = await call("POST", "/contacts/import/commit", {
      importId: ID,
      mapping: { c1: "name", c2: "phone" },
      origin: "inbound",
      originNote: "",
      confirmedRelationship: true,
      tagIds: [],
      listId: null,
    });
    expect(res.status).toBe(422);
  });

  it("importar do WhatsApp: confirmação, origem e seleção vazia são validadas antes de qualquer dado", async () => {
    const base = { importId: ID, rows: [{ phone: "+5567999990000", name: "Ana" }], origin: "form", originNote: "", confirmedRelationship: true, tagIds: [], listId: null };
    const post = (over: Record<string, unknown>) => call("POST", "/contacts/import/whatsapp/commit", { ...base, ...over });
    expect((await post({ confirmedRelationship: false })).status).toBe(422);
    expect((await post({ origin: "inbound" })).status).toBe(422);
    expect((await post({ rows: [] })).status).toBe(422);
    expect((await post({ importId: "abc" })).status).toBe(422);
    expect((await post({ tagIds: ["x"] })).status).toBe(422);
    expect((await call("POST", "/contacts/import/whatsapp/preview", {})).status).toBe(422);
  });

  it("período da agenda: fim antes do início e janela maior que 100 dias são rejeitados", async () => {
    expect((await call("GET", "/appointments?from=2025-06-10&to=2025-06-01")).status).toBe(422);
    expect((await call("GET", "/appointments?from=2025-01-01&to=2025-12-31")).status).toBe(422);
  });

  it("corpo que não é JSON é 422", async () => {
    const res = await app.request("/v1/contacts", { method: "POST", body: "não sou json", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(422);
  });
});
