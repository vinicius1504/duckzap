import { describe, expect, it } from "vitest";
import {
  buildDataBlock,
  buildRulesBlock,
  buildToolDefs,
  createInMemoryPorts,
  effectiveSchedulingConfig,
  enabledToolNames,
  executeTool,
  type AgentRuntimeConfig,
  type ToolContext,
} from "../src";
import { sampleConfig } from "../evals/harness";

const NOW = new Date("2026-10-28T13:00:00Z"); // quarta, 10:00 em São Paulo
const SCOPE = { organizationId: "o", conversationId: "c", contactId: "contact_test", agentId: "a" };

function setup(contactName: string | null, config: AgentRuntimeConfig = effectiveSchedulingConfig(sampleConfig(), ["apt_limpeza"])) {
  const { ports, state } = createInMemoryPorts({ now: () => NOW, contact: { name: contactName, email: null, phone: "+55 67 99999-0000", tags: [] } });
  const ctx: ToolContext = { scope: SCOPE, config, ports, dryRun: false, now: NOW, timeZone: "America/Sao_Paulo", allowedTags: [] };
  const defs = buildToolDefs(ctx, new Map([["apt_limpeza", "Limpeza"]]));
  return { ctx, defs, state, run: (name: string, input: Record<string, unknown>) => executeTool(defs, ctx, name, input) };
}

const SLOT = "slot:apt_limpeza:2026-10-29T17:00:00Z"; // quinta 14:00 em São Paulo

describe("agendar: nome do cliente é regra do servidor", () => {
  it("cadastro só com o telefone: recusa marcar e diz o que fazer; nada é gravado", async () => {
    const t = setup("+55 67 99999-0000");
    const out = await t.run("book_appointment", { slot_id: SLOT, type_id: "apt_limpeza" });
    expect(out.ok).toBe(false);
    expect(out.output).toMatch(/nome do cliente/);
    expect(out.output).toMatch(/update_contact_fields/);
    expect(t.state.appointments).toHaveLength(0);
    expect(t.state.writes.filter((w) => w.port === "agenda")).toEqual([]);
  });

  it("sem nome nenhum (null) também recusa", async () => {
    const t = setup(null);
    expect((await t.run("book_appointment", { slot_id: SLOT, type_id: "apt_limpeza" })).ok).toBe(false);
  });

  it("depois de salvar o nome pela ferramenta, marca", async () => {
    const t = setup("+55 67 99999-0000");
    expect((await t.run("book_appointment", { slot_id: SLOT, type_id: "apt_limpeza" })).ok).toBe(false);
    expect((await t.run("update_contact_fields", { name: "Carlos Eduardo" })).ok).toBe(true);
    const out = await t.run("book_appointment", { slot_id: SLOT, type_id: "apt_limpeza" });
    expect(out.ok).toBe(true);
    expect(t.state.appointments).toHaveLength(1);
    expect(t.state.appointments[0]).toMatchObject({ status: "confirmed" });
  });

  it("nome já cadastrado: marca direto", async () => {
    const t = setup("Maria Souza");
    expect((await t.run("book_appointment", { slot_id: SLOT, type_id: "apt_limpeza" })).ok).toBe(true);
  });
});

describe("agendar: o modelo só vê horário local", () => {
  it("lista de horários, confirmação e remarcação saem com dia da semana e hora no fuso da empresa, nunca em UTC", async () => {
    const t = setup("Maria Souza");
    const list = await t.run("list_available_slots", { type_id: "apt_limpeza", from_date: "2026-10-29", to_date: "2026-10-30" });
    expect(list.output).toContain("quinta-feira, 29/10 às 08:30");
    expect(list.output).toContain("quinta-feira, 29/10 às 14:00");
    // a ISO só aparece dentro do slot_id (identificador que o modelo devolve sem ler); fora dele, nada de UTC
    const readable = list.output.replace(/slot_id=\S+/g, "");
    expect(readable).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(readable).not.toMatch(/\bZ\b|UTC/);

    const booked = await t.run("book_appointment", { slot_id: SLOT, type_id: "apt_limpeza" });
    expect(booked.output).toContain("quinta-feira, 29/10 às 14:00");
    expect(booked.output).not.toMatch(/T17:00/);

    const id = t.state.appointments[0]!.id;
    const moved = await t.run("reschedule_appointment", { appointment_id: id, slot_id: "slot:apt_limpeza:2026-10-30T11:30:00Z" });
    expect(moved.output).toContain("sexta-feira, 30/10 às 08:30");
  });

  it("empresa em outro fuso: Campo Grande (UTC-4)", async () => {
    const t = setup("Maria Souza");
    t.ctx.timeZone = "America/Campo_Grande";
    const booked = await t.run("book_appointment", { slot_id: SLOT, type_id: "apt_limpeza" });
    expect(booked.output).toContain("quinta-feira, 29/10 às 13:00");
  });

  it("não consulta mais de 31 dias nem datas invertidas", async () => {
    const t = setup("Maria Souza");
    expect((await t.run("list_available_slots", { type_id: "apt_limpeza", from_date: "2026-10-29", to_date: "2026-12-30" })).ok).toBe(false);
    expect((await t.run("list_available_slots", { type_id: "apt_limpeza", from_date: "2026-10-30", to_date: "2026-10-29" })).ok).toBe(false);
  });
});

describe("agendar: o prompt", () => {
  it("as regras de agendamento só entram quando a empresa tem agenda", () => {
    const withAgenda = buildRulesBlock(effectiveSchedulingConfig(sampleConfig(), ["apt_limpeza"]));
    const without = buildRulesBlock(effectiveSchedulingConfig(sampleConfig(), []));
    expect(withAgenda).toContain("AGENDAMENTO");
    expect(withAgenda).toContain("list_available_slots");
    expect(without).not.toContain("AGENDAMENTO");
  });

  it("a agenda derivada também libera salvar o nome, e só quando há agenda", () => {
    const withAgenda = effectiveSchedulingConfig(sampleConfig({ advanced: { prompt: "p", tools: ["search_knowledge"] } }), ["apt_limpeza"]);
    expect(enabledToolNames(withAgenda).has("update_contact_fields")).toBe(true);
    const without = effectiveSchedulingConfig(sampleConfig({ advanced: { prompt: "p", tools: ["search_knowledge"] } }), []);
    expect(enabledToolNames(without).has("update_contact_fields")).toBe(false);
  });

  it("o bloco de dados mostra a data de hoje com fuso, o nome 'não informado' e os agendamentos em horário local", () => {
    const block = buildDataBlock({
      nonce: "n",
      history: [{ role: "customer", text: "oi" }],
      contact: { name: "+55 67 99999-0000", email: null, phone: null, tags: [] },
      appointments: [{ id: "apt_1", typeId: "apt_limpeza", startsAt: "2026-10-30T17:00:00Z", status: "pending" }],
      nowLabel: "quarta-feira, 28/10/2026, 10:00 (fuso America/Sao_Paulo; hoje é 2026-10-28)",
      timeZone: "America/Sao_Paulo",
      typeNames: new Map([["apt_limpeza", "Limpeza"]]),
    });
    expect(block).toContain("nome: (não informado)");
    expect(block).toContain("hoje é 2026-10-28");
    expect(block).toContain("apt_1 | Limpeza | sexta-feira, 30/10 às 14:00 | pending");
    expect(block).not.toContain("T17:00:00Z");
  });
});

describe("agendar: consulta dirigida, poucos horários", () => {
  it("faixa de hora: 'tarde', 'depois das 14h' e 'às 08:30' filtram no horário LOCAL", async () => {
    const t = setup("Maria Souza");
    const window = { type_id: "apt_limpeza", from_date: "2026-10-29", to_date: "2026-10-30" };
    const afternoon = await t.run("list_available_slots", { ...window, from_time: "12:00", to_time: "23:59" });
    expect(afternoon.output).toContain("às 14:00");
    expect(afternoon.output).not.toContain("às 08:30");
    const morning = await t.run("list_available_slots", { ...window, from_time: "00:00", to_time: "11:59" });
    expect(morning.output).toContain("às 08:30");
    expect(morning.output).not.toContain("às 14:00");
    const exact = await t.run("list_available_slots", { ...window, from_time: "08:30", to_time: "08:30" });
    expect(exact.output.split("\n").filter((l) => l.startsWith("slot_id="))).toHaveLength(2); // 29/10 e 30/10 às 08:30
  });

  it("faixa sem horário avisa que há outros no período e não inventa", async () => {
    const t = setup("Maria Souza");
    const out = await t.run("list_available_slots", { type_id: "apt_limpeza", from_date: "2026-10-29", to_date: "2026-10-30", from_time: "18:00", to_time: "19:00" });
    expect(out.ok).toBe(true);
    expect(out.output).toMatch(/Sem horários livres nessa faixa/);
  });

  it("hora inválida ou invertida é recusada com mensagem para o modelo corrigir", async () => {
    const t = setup("Maria Souza");
    const base = { type_id: "apt_limpeza", from_date: "2026-10-29", to_date: "2026-10-30" };
    expect((await t.run("list_available_slots", { ...base, from_time: "25:00" })).ok).toBe(false);
    expect((await t.run("list_available_slots", { ...base, from_time: "15:00", to_time: "09:00" })).ok).toBe(false);
  });

  it("janela de mais de 14 dias é recusada e a mensagem manda perguntar a semana", async () => {
    const t = setup("Maria Souza");
    const out = await t.run("list_available_slots", { type_id: "apt_limpeza", from_date: "2026-11-01", to_date: "2026-11-30" });
    expect(out.ok).toBe(false);
    expect(out.output).toMatch(/14 dias/);
    expect(out.output).toMatch(/semana/);
  });

  it("uma semana de horários vira poucas linhas (um por dia), com aviso de quantos existem", async () => {
    const t = setup("Maria Souza");
    const out = await t.run("list_available_slots", { type_id: "apt_limpeza", from_date: "2026-10-29", to_date: "2026-11-06" });
    const lines = out.output.split("\n");
    const slots = lines.filter((l) => l.startsWith("slot_id="));
    expect(slots.length).toBeLessThanOrEqual(8);
    expect(new Set(slots.map((l) => l.split("|")[1]?.split(" às ")[0]?.trim())).size).toBe(slots.length); // dias diferentes
    expect(lines.at(-1)).toMatch(/de \d+ horários livres/);
  });

  it("um dia só mostra vários horários do dia (para o cliente escolher)", async () => {
    const t = setup("Maria Souza");
    const out = await t.run("list_available_slots", { type_id: "apt_limpeza", from_date: "2026-10-29", to_date: "2026-10-29" });
    expect(out.output.split("\n").filter((l) => l.startsWith("slot_id=")).length).toBe(2); // a agenda de teste tem 08:30 e 14:00
  });
});
