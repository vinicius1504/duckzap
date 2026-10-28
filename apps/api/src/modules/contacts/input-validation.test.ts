import { describe, expect, it, vi } from "vitest";
import { appointmentsRoutes } from "../appointments/routes";
import type { Deps } from "../../lib/context";
import { contactsRoutes } from "./routes";

// Ids malformados nos corpos precisam virar 422 ANTES de tocar o banco (antes: erro de SQL → 500).
// O banco aqui é um Proxy que explode se alguém o usar: se a validação deixar passar, o teste falha.
vi.mock("../session/queries", () => ({
  buildSession: async () => ({
    ok: true,
    session: {
      user: { id: "usr_1", name: "Marina", email: "m@exemplo.com", role: "owner" },
      organization: { id: "org_1", name: "Casa", plan: "pro", subscriptionStatus: "active", timeZone: "America/Sao_Paulo" },
    },
  }),
}));

const db = new Proxy({}, {
  get() {
    throw new Error("o banco não deveria ser tocado: a validação tinha que barrar antes");
  },
}) as Deps["db"];
const deps: Deps = {
  env: {} as Deps["env"],
  db,
  auth: { api: { getSession: async () => ({ user: { id: "usr_1" }, session: { id: "s" } }) } } as unknown as Deps["auth"],
  llm: { name: "fake", generate: async () => { throw new Error("sem IA"); } },
};

const GOOD = "0190a4f2-8c1e-7a53-9d2b-4f6e8a1c3b57";
const contacts = contactsRoutes(deps);
const appointments = appointmentsRoutes(deps);

const post = (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function expect422(res: Response, field: string) {
  expect(res.status).toBe(422);
  const body = (await res.json()) as { error: { code: string; message: string; fields: Record<string, string> } };
  expect(body.error.code).toBe("validation_error");
  expect(body.error.message).toMatch(/^Campo "/);
  expect(Object.keys(body.error.fields).join(",")).toContain(field);
}

const contact = (over: Record<string, unknown> = {}) => ({
  name: "Ana",
  phone: "67998123456",
  email: "",
  instagram: "",
  isCustomer: false,
  tagIds: [],
  origin: "form",
  originNote: "",
  ownerId: null,
  birthDate: "",
  ...over,
});

describe("Clientes — ids malformados viram 422", () => {
  it("POST /contacts com tagIds inválido", async () => expect422(await post(contacts, "/contacts", contact({ tagIds: ["nao-e-uuid"] })), "tagIds"));
  it("PATCH /contacts/:id com tagIds inválido", async () => {
    const res = await contacts.request(`/contacts/${GOOD}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(contact({ tagIds: ["1 or 1=1"] })) });
    await expect422(res, "tagIds");
  });
  it("POST /contacts/export com contactIds inválido", async () =>
    expect422(await post(contacts, "/contacts/export", { contactIds: ["x"], filter: null }), "contactIds"));
  it("POST /contacts/export com tagId do filtro inválido", async () =>
    expect422(await post(contacts, "/contacts/export", { contactIds: null, filter: { tagId: "x" } }), "filter.tagId"));
  it("POST /contacts/import/commit com importId inválido", async () =>
    expect422(
      await post(contacts, "/contacts/import/commit", {
        importId: "x",
        mapping: {},
        origin: "customer",
        originNote: "",
        confirmedRelationship: true,
        tagIds: [],
        listId: null,
      }),
      "importId",
    ));
  it("GET /contacts com tagId/listId inválido na query", async () => {
    await expect422(await contacts.request("/contacts?tagId=zzz"), "tagId");
    await expect422(await contacts.request("/contacts?listId=zzz"), "listId");
  });
  it("id de rota malformado continua 404", async () => {
    expect((await contacts.request("/contacts/xyz")).status).toBe(404);
  });
});

describe("Agenda — ids malformados viram 422", () => {
  const appointment = (over: Record<string, unknown> = {}) => ({
    contactId: GOOD,
    typeId: GOOD,
    ownerId: "usr_1",
    date: "2026-11-02",
    time: "09:00",
    durationMinutes: 30,
    notes: "",
    allowConflict: false,
    ...over,
  });
  it("contactId", async () => expect422(await post(appointments, "/appointments", appointment({ contactId: "abc" })), "contactId"));
  it("typeId", async () => expect422(await post(appointments, "/appointments", appointment({ typeId: "abc" })), "typeId"));
  it("ownerId vazio", async () => expect422(await post(appointments, "/appointments", appointment({ ownerId: "" })), "ownerId"));
  it("PATCH também valida", async () => {
    const res = await appointments.request(`/appointments/${GOOD}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(appointment({ contactId: "abc" })),
    });
    await expect422(res, "contactId");
  });
});
