import { createFakeLlm, createSimulatorPorts } from "@duckzap/ai";
import type { NotificationList } from "@duckzap/contracts/notifications";
import { createDb, schema, withOrg } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Deps } from "../../lib/context";
import { setRealtimePublisher } from "../../lib/realtime";
import { withOrgRealtime } from "../../lib/realtime";
import type { RealtimeEnvelope } from "@duckzap/contracts/realtime";
import { onError } from "../../middleware/error-handler";
import { createRealPorts } from "../conversations/ai-ports";
import type { ConversationRow } from "../conversations/queries";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { notificationsRoutes } from "./routes";
import { notifyMembers, READ_RETENTION_DAYS } from "./service";

/**
 * INTEGRAÇÃO — Postgres real, papel `duckzap_app`, com a migration de notificações aplicada. Só contra banco descartável:
 *
 *   NOTIFICATIONS_INTEGRATION=1 DATABASE_URL=<papel duckzap_app> DATABASE_ADMIN_URL=<dono> npx vitest run src/modules/notifications
 *
 * A empresa, as pessoas, as equipes, os contatos e as conversas são criados aqui e removidos no fim. Os agendamentos saem
 * das portas REAIS da IA (`createRealPorts`), como no atendimento ao vivo.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
const enabled = process.env.NOTIFICATIONS_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_ADMIN_URL);

const run = Math.random().toString(36).slice(2, 8);
const TZ = "America/Sao_Paulo";

describe.skipIf(!enabled)("Notificações — integração (precisa da migration)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 6 });
  afterAll(close);

  const sessions: Record<string, unknown> = {};
  const deps = {
    db,
    llm: createFakeLlm(),
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null } },
  } as unknown as Deps;
  const app = new OpenAPIHono();
  app.route("/v1", notificationsRoutes(deps));
  app.onError(onError);
  const call = (as: string | null, method: string, path: string, body?: unknown) =>
    app.request(`/v1${path}`, {
      method,
      headers: { ...(as ? { "x-test-user": as } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

  const events: RealtimeEnvelope[] = [];
  const invalidations = (org: string) => events.filter((e) => e.organizationId === org && e.event.type === "notifications.invalidate").length;

  let main: SecondOrg;
  let other: SecondOrg;
  let A = "";
  const P = {} as Record<"owner" | "adm" | "a1" | "a2" | "ina" | "b1" | "solo", string>;
  const T = { x: uuidv7(), y: uuidv7(), z: uuidv7(), type: uuidv7(), agent: uuidv7() };
  const session = (id: string, name: string, org: string) => ({ user: { id, name, email: `${id}@example.test` }, session: { id: `s-${id}`, activeOrganizationId: org } });

  beforeAll(async () => {
    setRealtimePublisher((envelope) => void events.push(envelope));
    main = await createSecondOrg("notif", {
      ownerName: "Dona Notif",
      extra: [
        { key: "adm", role: "admin", name: "Admin Notif" },
        { key: "a1", role: "member", name: "Ana Equipe X" },
        { key: "a2", role: "member", name: "Beto Equipe X" },
        { key: "ina", role: "member", name: "Inativa Equipe X" },
        { key: "b1", role: "member", name: "Caio Equipe Y" },
        { key: "solo", role: "member", name: "Solo Sem Equipe" },
      ],
    });
    other = await createSecondOrg("notif-outra", { extra: [{ key: "adm", role: "admin" }] });
    A = main.orgId;
    P.owner = main.userId;
    for (const key of ["adm", "a1", "a2", "ina", "b1", "solo"] as const) P[key] = main.members[key]!.userId;
    sessions.owner = session(P.owner, "Dona Notif", A);
    for (const key of ["adm", "a1", "a2", "b1", "solo"] as const) sessions[key] = session(P[key], key, A);
    sessions.other = session(other.userId, other.userName, other.orgId);

    await withOrg(db, A, async (tx) => {
      const hours = Array.from({ length: 7 }, (_, day) => ({ day, open: day >= 1 && day <= 5, start: "08:00", end: "18:00" }));
      await tx.insert(schema.teams).values([
        { id: T.x, organizationId: A, name: `Equipe X ${run}`, color: "blue", priority: 1, businessHours: hours },
        { id: T.y, organizationId: A, name: `Equipe Y ${run}`, color: "green", priority: 2, businessHours: hours },
        { id: T.z, organizationId: A, name: `Equipe Z ${run}`, color: "red", priority: 3, businessHours: hours },
      ]);
      await tx.insert(schema.teamMembers).values([
        { teamId: T.x, organizationId: A, memberRef: P.a1 },
        { teamId: T.x, organizationId: A, memberRef: P.a2 },
        { teamId: T.x, organizationId: A, memberRef: P.ina },
        { teamId: T.x, organizationId: A, memberRef: `inv_${run}` }, // convite pendente: não é pessoa da empresa ainda
        { teamId: T.y, organizationId: A, memberRef: P.b1 },
        { teamId: T.z, organizationId: A, memberRef: P.ina }, // equipe só com gente inativa
      ]);
      await tx.insert(schema.memberProfiles).values({ id: uuidv7(), organizationId: A, userId: P.ina, active: false });
      await tx.insert(schema.appointmentTypes).values({ id: T.type, organizationId: A, name: `Reunião de apresentação ${run}`, durationMinutes: 30 });
    });
  });

  afterAll(async () => {
    setRealtimePublisher(null);
    await main?.remove();
    await other?.remove();
  });

  // ── cenário ───────────────────────────────────────────────────────────────
  async function scenario(teamId: string | null, ownerId: string | null, name = "Maria Souza") {
    const contactId = uuidv7();
    const convId = uuidv7();
    const phone = `+55679${randomInt(10_000_000, 99_999_999)}`;
    return withOrg(db, A, async (tx) => {
      await tx.insert(schema.contacts).values({ id: contactId, organizationId: A, name, phone, ownerId });
      const [conv] = await tx
        .insert(schema.conversations)
        .values({ id: convId, organizationId: A, contactId, teamId, status: "ai_active", mode: "ai" })
        .returning();
      return { conv: conv as ConversationRow, contactId, phone };
    });
  }

  /** Roda a IA ao vivo numa conversa: as portas reais na transação, com os avisos de tempo real saindo depois do commit. */
  function live<T>(conv: ConversationRow, agentName: string, fn: (ports: ReturnType<typeof createRealPorts>, scope: { organizationId: string; conversationId: string; contactId: string; agentId: string }) => Promise<T>) {
    return withOrgRealtime(db, A, async (tx) => {
      const ports = createRealPorts({
        tx,
        db,
        conv,
        agentName,
        ctx: { organizationId: A, userId: "system", userName: "Sistema", timeZone: TZ, orgName: "x" },
        lastCustomerText: "",
        now: new Date(),
      });
      return fn(ports, { organizationId: A, conversationId: conv.id, contactId: conv.contactId, agentId: T.agent });
    });
  }

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  async function freeSlot(ports: ReturnType<typeof createRealPorts>, scope: Parameters<Parameters<typeof live>[2]>[1], skip = 0) {
    const slots = await ports.agenda.listAvailableSlots(scope, { typeId: T.type, from: day(2), to: day(9) });
    const slot = slots[skip];
    if (!slot) throw new Error("sem horário livre no teste");
    return slot;
  }

  const notifsOf = (userId: string, org = A) => withOrg(db, org, (tx) => tx.select().from(schema.notifications).where(eq(schema.notifications.userId, userId)));
  const allOf = (org: string) => withOrg(db, org, (tx) => tx.select().from(schema.notifications));
  const ids = (list: { id: string }[]) => list.map((n) => n.id);

  // ── quem recebe ───────────────────────────────────────────────────────────
  describe("a IA marca, remarca e cancela", () => {
    it("marcar avisa a equipe da conversa + o responsável; não avisa outra equipe, inativa, convite, outra empresa nem o dono", async () => {
      const { conv } = await scenario(T.x, null);
      // o responsável pelo agendamento é a pessoa 'solo' (dona do cadastro do cliente), fora da equipe
      await withOrg(db, A, (tx) => tx.update(schema.contacts).set({ ownerId: P.solo }).where(eq(schema.contacts.id, conv.contactId)));
      events.length = 0;
      const booked = await live(conv, `Jacan ${run}`, async (ports, scope) => {
        const slot = await freeSlot(ports, scope);
        return ports.agenda.bookAppointment(scope, { typeId: T.type, slotId: slot.id });
      });
      expect(booked.status).toBe("confirmed");

      const count = async (k: keyof typeof P) => (await notifsOf(P[k])).length;
      expect([await count("a1"), await count("a2"), await count("solo")]).toEqual([1, 1, 1]);
      expect([await count("ina"), await count("b1"), await count("adm"), await count("owner")]).toEqual([0, 0, 0, 0]);
      // nenhuma linha de gente de fora da empresa, e a outra empresa não enxerga nada
      expect((await allOf(A)).map((n) => n.userId).sort()).toEqual([P.a1, P.a2, P.solo].sort());
      expect(await allOf(other.orgId)).toHaveLength(0);

      const [n] = await notifsOf(P.a1);
      if (!n) throw new Error("sem notificação");
      expect(n).toMatchObject({ kind: "appointment_booked", title: `Jacan ${run} marcou um agendamento`, link: `/conversas?conversa=${conv.id}`, readAt: null });
      expect(n.body).toMatch(new RegExp(`^Maria Souza · Reunião de apresentação ${run} · \\p{L}+-feira, \\d{2}/\\d{2} às \\d{2}:\\d{2}$`, "u"));
      expect(invalidations(A)).toBe(1); // UM aviso em tempo real, não um por pessoa
    });

    it("sem equipe, ou equipe sem ninguém ativo: proprietários e administradores (mais o responsável)", async () => {
      for (const teamId of [null, T.z]) {
        const { conv } = await scenario(teamId, P.b1);
        await live(conv, "Jacan", async (ports, scope) => ports.agenda.bookAppointment(scope, { typeId: T.type, slotId: (await freeSlot(ports, scope)).id }));
        const created = (await allOf(A)).filter((n) => n.link === `/conversas?conversa=${conv.id}`);
        expect(created.map((n) => n.userId).sort()).toEqual([P.owner, P.adm, P.b1].sort());
      }
    });

    it("remarcar e cancelar também avisam, com o horário novo / o que foi cancelado", async () => {
      const { conv } = await scenario(T.y, null, "Paulo Lima");
      const link = `/conversas?conversa=${conv.id}`;
      const first = await live(conv, "Jacan", async (ports, scope) => ports.agenda.bookAppointment(scope, { typeId: T.type, slotId: (await freeSlot(ports, scope)).id }));
      const moved = await live(conv, "Jacan", async (ports, scope) => {
        const slot = await freeSlot(ports, scope, 3);
        return { slot, appt: await ports.agenda.rescheduleAppointment(scope, { appointmentId: first.id, slotId: slot.id }) };
      });
      await live(conv, "Jacan", async (ports, scope) => ports.agenda.cancelAppointment(scope, { appointmentId: first.id }));

      const mine = (await notifsOf(P.b1)).filter((n) => n.link === link).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.kind.localeCompare(b.kind));
      expect(mine.map((n) => n.kind).sort()).toEqual(["appointment_booked", "appointment_canceled", "appointment_rescheduled"]);
      const resched = mine.find((n) => n.kind === "appointment_rescheduled")!;
      const canceled = mine.find((n) => n.kind === "appointment_canceled")!;
      expect(resched.title).toBe("Jacan remarcou um agendamento");
      expect(canceled.title).toBe("Jacan cancelou um agendamento");
      const hhmm = (iso: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
      expect(resched.body).toContain(`às ${hhmm(moved.slot.startsAt)}`); // o horário NOVO
      expect(canceled.body).toContain(`às ${hhmm(moved.appt.startsAt)}`); // o horário que foi cancelado (o remarcado)
      expect(resched.body.startsWith("Paulo Lima · Reunião de apresentação")).toBe(true);
    });

    it("cadastro só com o telefone: o corpo usa o telefone", async () => {
      const { conv, phone } = await scenario(T.y, null);
      // a IA pergunta o nome antes de marcar, mas a porta aceita o cadastro só com o telefone e mostra o telefone
      await withOrg(db, A, (tx) => tx.update(schema.contacts).set({ name: phone }).where(eq(schema.contacts.id, conv.contactId)));
      await live(conv, "Jacan", async (ports, scope) => ports.agenda.bookAppointment(scope, { typeId: T.type, slotId: (await freeSlot(ports, scope)).id }));
      const n = (await notifsOf(P.b1)).find((x) => x.link === `/conversas?conversa=${conv.id}`);
      expect(n?.body.startsWith(`${phone} · `)).toBe(true);
    });

    it("falha ao notificar NÃO desfaz nem impede o agendamento (savepoint) e não publica o aviso", async () => {
      const { conv } = await scenario(T.y, null);
      const adminUrl = process.env.DATABASE_ADMIN_URL!;
      const owner = createDb(adminUrl, { max: 1 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        // gatilho que só recusa as notificações deste teste (o agente se chama 'Falha Teste …'): nada mais é afetado
        await owner.db.execute(sql`create or replace function notif_fail_test() returns trigger language plpgsql as $$ begin if new.title like 'Falha Teste%' then raise exception 'falha simulada'; end if; return new; end $$`);
        await owner.db.execute(sql`create trigger notif_fail_test before insert on notifications for each row execute function notif_fail_test()`);
        events.length = 0;
        const result = await live(conv, `Falha Teste ${run}`, async (ports, scope) => ports.agenda.bookAppointment(scope, { typeId: T.type, slotId: (await freeSlot(ports, scope)).id }));
        expect(result.status).toBe("confirmed");
        const appts = await withOrg(db, A, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.contactId, conv.contactId)));
        expect(appts).toHaveLength(1);
        expect(appts[0]).toMatchObject({ status: "confirmed", source: "ai_agent" });
        expect((await allOf(A)).filter((n) => n.link === `/conversas?conversa=${conv.id}`)).toHaveLength(0);
        expect(invalidations(A)).toBe(0);
        expect(warn).toHaveBeenCalled();
        // e o log não carrega dado pessoal
        expect(JSON.stringify(warn.mock.calls)).not.toContain("Maria Souza");
      } finally {
        warn.mockRestore();
        await owner.db.execute(sql`drop trigger if exists notif_fail_test on notifications`);
        await owner.db.execute(sql`drop function if exists notif_fail_test()`);
        await owner.close();
      }
    });

    it("o simulador (portas em memória) não grava notificação", async () => {
      const before = (await allOf(A)).length;
      const { ports } = createSimulatorPorts({ types: [{ id: T.type, name: "Reunião", durationMinutes: 30, staffOnly: false }] });
      const scope = { organizationId: A, conversationId: "sim", contactId: "ficticio", agentId: T.agent };
      const slots = await ports.agenda.listAvailableSlots(scope, { typeId: T.type, from: day(2), to: day(9) });
      if (slots[0]) await ports.agenda.bookAppointment(scope, { typeId: T.type, slotId: slots[0].id });
      expect((await allOf(A)).length).toBe(before);
    });
  });

  // ── API ───────────────────────────────────────────────────────────────────
  describe("GET /v1/notifications e POST /v1/notifications/read", () => {
    const mk = (userId: string, i: number, over: Partial<typeof schema.notifications.$inferInsert> = {}) => ({
      id: uuidv7(),
      organizationId: A,
      userId,
      kind: "appointment_booked",
      title: `Aviso ${run} ${i}`,
      body: "corpo",
      link: null,
      createdAt: new Date(Date.now() - 60_000 * (100 - i)),
      ...over,
    });

    it("exige sessão", async () => {
      expect((await call(null, "GET", "/notifications")).status).toBe(401);
      expect((await call(null, "POST", "/notifications/read", { all: true })).status).toBe(401);
    });

    it("traz só as da própria pessoa (mais novas primeiro, até 30) e o total de não lidas", async () => {
      const mine = Array.from({ length: 35 }, (_, i) => mk(P.a2, i));
      const others = [mk(P.b1, 1), mk(P.owner, 2)];
      await withOrg(db, A, (tx) => tx.insert(schema.notifications).values([...mine, ...others, mk(P.a2, 99, { readAt: new Date(), title: `Lida ${run}` })]));
      const before = (await notifsOf(P.a2)).filter((n) => n.readAt === null).length;
      const res = await call("a2", "GET", "/notifications");
      expect(res.status).toBe(200);
      const list = await json<NotificationList>(res);
      expect(list.items).toHaveLength(30);
      expect(list.unreadCount).toBe(before); // total, mesmo maior que a página
      expect(list.unreadCount).toBeGreaterThan(30);
      const stamps = list.items.map((n) => n.createdAt);
      expect([...stamps].sort().reverse()).toEqual(stamps);
      // nenhuma é de outra pessoa
      const mineIds = new Set(ids(await notifsOf(P.a2)));
      expect(list.items.every((n) => mineIds.has(n.id))).toBe(true);
      expect(list.items.some((n) => n.title.startsWith(`Lida ${run}`))).toBe(true); // lidas também entram
      // outra empresa nunca vê estas
      const foreign = await json<NotificationList>(await call("other", "GET", "/notifications"));
      expect(foreign).toEqual({ items: [], unreadCount: 0 });
    });

    it("read: marca só as próprias; id alheio, de outra empresa ou malformado é ignorado; idempotente", async () => {
      const [a, b, c] = [mk(P.solo, 1), mk(P.solo, 2), mk(P.solo, 3)];
      const theirs = mk(P.adm, 1);
      await withOrg(db, A, (tx) => tx.insert(schema.notifications).values([a, b, c, theirs]));
      const base = (await json<NotificationList>(await call("solo", "GET", "/notifications"))).unreadCount;

      const r1 = await call("solo", "POST", "/notifications/read", { ids: [a.id, theirs.id, "nao-e-uuid", uuidv7()] });
      expect(r1.status).toBe(200);
      expect(await json(r1)).toEqual({ ok: true, unreadCount: base - 1 });
      // a de outra pessoa continua não lida; a minha ficou lida
      const rows = await allOf(A);
      expect(rows.find((n) => n.id === theirs.id)?.readAt).toBeNull();
      const readAt = rows.find((n) => n.id === a.id)?.readAt;
      expect(readAt).not.toBeNull();

      // repetir não muda nada (nem o carimbo de leitura)
      const r2 = await call("solo", "POST", "/notifications/read", { ids: [a.id] });
      expect(await json(r2)).toEqual({ ok: true, unreadCount: base - 1 });
      expect((await allOf(A)).find((n) => n.id === a.id)?.readAt?.getTime()).toBe(readAt?.getTime());

      // outra empresa tentando marcar a minha: ignorado, sem revelar nada
      const foreign = await call("other", "POST", "/notifications/read", { ids: [b.id] });
      expect(foreign.status).toBe(200);
      expect(await json(foreign)).toEqual({ ok: true, unreadCount: 0 });
      expect((await allOf(A)).find((n) => n.id === b.id)?.readAt).toBeNull();

      // all: todas as minhas, só as minhas
      const all = await call("solo", "POST", "/notifications/read", { all: true });
      expect(await json(all)).toEqual({ ok: true, unreadCount: 0 });
      expect((await notifsOf(P.solo)).every((n) => n.readAt !== null)).toBe(true);
      expect((await allOf(A)).find((n) => n.id === theirs.id)?.readAt).toBeNull();
      expect((await json<NotificationList>(await call("solo", "GET", "/notifications"))).unreadCount).toBe(0);
    });

    it("corpo inválido (sem all nem ids) é 422", async () => {
      expect((await call("solo", "POST", "/notifications/read", {})).status).toBe(422);
      expect((await call("solo", "POST", "/notifications/read", { ids: [] })).status).toBe(422);
    });
  });

  // ── serviço ───────────────────────────────────────────────────────────────
  describe("notifyMembers", () => {
    const payload = { kind: "appointment_booked", title: `Titulo ${run}`, body: "b", link: null } as const;

    it("ids repetidos viram uma linha por pessoa; lista vazia não grava nem avisa", async () => {
      events.length = 0;
      await withOrgRealtime(db, A, (tx) => notifyMembers(tx, A, [], payload));
      expect(invalidations(A)).toBe(0);
      await withOrgRealtime(db, A, (tx) => notifyMembers(tx, A, [P.a1, P.a1, P.b1], payload));
      expect(invalidations(A)).toBe(1);
      expect((await allOf(A)).filter((n) => n.title === payload.title).map((n) => n.userId).sort()).toEqual([P.a1, P.b1].sort());
    });

    it("transação que falha não publica aviso", async () => {
      events.length = 0;
      await expect(
        withOrgRealtime(db, A, async (tx) => {
          await notifyMembers(tx, A, [P.a1], { ...payload, title: `Revertida ${run}` });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(invalidations(A)).toBe(0);
      expect((await allOf(A)).some((n) => n.title === `Revertida ${run}`)).toBe(false);
    });

    it(`retenção: ao gravar, apaga lidas com mais de ${READ_RETENTION_DAYS} dias da empresa; mantém recentes e não lidas`, async () => {
      const old = new Date(Date.now() - (READ_RETENTION_DAYS + 1) * 86_400_000);
      const recent = new Date(Date.now() - 10 * 86_400_000);
      const row = (title: string, readAt: Date | null, createdAt = old) => ({ id: uuidv7(), organizationId: A, userId: P.owner, kind: "appointment_booked", title, body: "b", link: null, readAt, createdAt });
      const oldRead = row(`velha lida ${run}`, old);
      const recentRead = row(`recente lida ${run}`, recent);
      const oldUnread = row(`velha não lida ${run}`, null);
      await withOrg(db, A, (tx) => tx.insert(schema.notifications).values([oldRead, recentRead, oldUnread]));
      await withOrg(db, A, (tx) => notifyMembers(tx, A, [P.owner], { ...payload, title: `Gatilho ${run}` }));
      const left = ids(await notifsOf(P.owner));
      expect(left).not.toContain(oldRead.id);
      expect(left).toContain(recentRead.id);
      expect(left).toContain(oldUnread.id);
    });

    it("RLS: o papel do app não vê notificações de outra empresa", async () => {
      const seen = await withOrg(db, other.orgId, (tx) => tx.select().from(schema.notifications).where(inArray(schema.notifications.userId, [P.a1, P.b1, P.solo])));
      expect(seen).toHaveLength(0);
      const mixed = await withOrg(db, A, (tx) => tx.select().from(schema.notifications).where(and(eq(schema.notifications.organizationId, other.orgId))));
      expect(mixed).toHaveLength(0);
    });
  });
});
