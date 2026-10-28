import { describe, expect, it } from "vitest";
import { bookableTypeIds, buildToolDefs, effectiveSchedulingConfig, enabledToolNames, SCHEDULING_TOOLS, type AgentRuntimeConfig } from "../src";
import { runScenario, sampleConfig, type Scenario } from "../evals/harness";
import { createInMemoryPorts } from "../src";

const noSchedulingTools = ["search_knowledge", "add_tag", "request_human"];
const legacyOff = (over: Partial<AgentRuntimeConfig> = {}) =>
  sampleConfig({ scheduling: { canBook: false, appointmentTypeIds: [] }, advanced: { prompt: "p", tools: noSchedulingTools }, ...over });
const schedulingToolsOf = (c: AgentRuntimeConfig) => c.advanced.tools.filter((t) => (SCHEDULING_TOOLS as readonly string[]).includes(t));

describe("effectiveSchedulingConfig (agenda é função do sistema)", () => {
  it("empresa com tipos: agente legado (canBook=false, sem ferramentas) passa a ter as 3 ferramentas e todos os tipos", () => {
    const effective = effectiveSchedulingConfig(legacyOff(), ["apt_a", "apt_b"]);
    expect(effective.scheduling).toEqual({ canBook: true, appointmentTypeIds: ["apt_a", "apt_b"] });
    expect(schedulingToolsOf(effective).sort()).toEqual(["book_appointment", "list_available_slots", "reschedule_appointment"]);
    expect(effective.advanced.tools).toEqual(expect.arrayContaining(noSchedulingTools)); // as outras seguem
    const enabled = enabledToolNames(effective);
    for (const t of ["list_available_slots", "book_appointment", "reschedule_appointment", "cancel_appointment"] as const) expect(enabled.has(t)).toBe(true);
  });

  it("empresa sem tipos: nenhuma ferramenta de agenda, mesmo se o agente tinha canBook=true, ids e as ferramentas ligadas", () => {
    const legacyOn = sampleConfig(); // canBook=true, 2 ids, ferramentas de agenda ligadas
    expect(schedulingToolsOf(legacyOn).length).toBeGreaterThan(0);
    const effective = effectiveSchedulingConfig(legacyOn, []);
    expect(effective.scheduling).toEqual({ canBook: false, appointmentTypeIds: [] });
    expect(schedulingToolsOf(effective)).toEqual([]);
    const enabled = enabledToolNames(effective);
    for (const t of SCHEDULING_TOOLS) expect(enabled.has(t)).toBe(false);
    const names = buildToolDefs({ scope: { organizationId: "o", conversationId: "c", contactId: "k", agentId: "a" }, config: effective, ports: createInMemoryPorts().ports, dryRun: false, now: new Date(), allowedTags: [] }).map((d) => d.name);
    expect(names.filter((n) => (SCHEDULING_TOOLS as readonly string[]).includes(n))).toEqual([]);
    expect(effective.advanced.tools).toContain("request_human");
  });

  it("ids do agente (legado) são ignorados: valem só os da empresa", () => {
    const effective = effectiveSchedulingConfig(sampleConfig(), ["apt_da_empresa"]);
    expect(effective.scheduling.appointmentTypeIds).toEqual(["apt_da_empresa"]);
  });

  it("é pura e idempotente: não muda a config recebida; repetir dá o mesmo resultado; ids repetidos viram um", () => {
    const base = legacyOff();
    const snapshot = JSON.stringify(base);
    const once = effectiveSchedulingConfig(base, ["a", "a", "b"]);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(once.scheduling.appointmentTypeIds).toEqual(["a", "b"]);
    expect(effectiveSchedulingConfig(once, ["a", "b"])).toEqual(once);
    expect(schedulingToolsOf(once)).toHaveLength(3); // sem duplicar
  });

  it("não mexe em mais nada da config (persona, conhecimento, follow-up)", () => {
    const base = legacyOff();
    const { scheduling: _s, advanced: _a, ...restBase } = base;
    const { scheduling: _s2, advanced: _a2, ...restEffective } = effectiveSchedulingConfig(base, ["x"]);
    void [_s, _a, _s2, _a2];
    expect(restEffective).toEqual(restBase);
  });
});

describe("bookableTypeIds", () => {
  it("só tipos ativos e que não são 'só a equipe marca'", () => {
    const ids = bookableTypeIds([
      { id: "a", active: true, staffOnly: false },
      { id: "b", active: false, staffOnly: false },
      { id: "c", active: true, staffOnly: true },
      { id: "d" },
      { id: "a" },
    ]);
    expect(ids).toEqual(["a", "d"]);
  });

  it("empresa só com tipos inativos ou só-equipe não tem agenda para a IA", () => {
    const ids = bookableTypeIds([{ id: "b", active: false }, { id: "c", staffOnly: true }]);
    expect(ids).toEqual([]);
    expect(enabledToolNames(effectiveSchedulingConfig(legacyOff(), ids)).has("book_appointment")).toBe(false);
  });
});

describe("pipeline com a agenda derivada", () => {
  const book = (config: AgentRuntimeConfig, mode?: Scenario["mode"]): Scenario => ({
    id: "sched",
    description: "sched",
    mode,
    config,
    history: [{ role: "customer", text: "Quero marcar limpeza" }, { role: "agent", text: "Tenho 08h30 ou 14h. Qual prefere?" }, { role: "customer", text: "14h" }],
    router: { intent: "schedule", confidence: 0.95 },
    model: [
      { toolCalls: [{ id: "t1", name: "book_appointment", input: { slot_id: "slot:apt_limpeza:2026-10-27T17:00:00Z", type_id: "apt_limpeza" } }], stopReason: "tool_use" },
      "Pronto! Deixei pré-agendado para terça às 14h; a equipe confirma em seguida.",
    ],
    expect: {},
  });

  it("ao vivo: agente com canBook=false marca horário quando a empresa tem tipos", async () => {
    const { fake, result } = await runScenario(book(effectiveSchedulingConfig(legacyOff(), ["apt_limpeza"])));
    expect(result.toolCalls.map((t) => t.tool)).toContain("book_appointment");
    expect(fake.appointments).toHaveLength(1);
    expect(fake.appointments[0]).toMatchObject({ status: "confirmed", contactId: "contact_test" });
  });

  it("controle: sem a derivação, o mesmo agente legado NÃO consegue marcar", async () => {
    const { fake } = await runScenario(book(legacyOff()));
    expect(fake.appointments).toHaveLength(0);
  });

  it("empresa sem tipos: a IA não tem como marcar", async () => {
    const { fake } = await runScenario(book(effectiveSchedulingConfig(sampleConfig(), [])));
    expect(fake.appointments).toHaveLength(0);
  });

  it("Copiloto e simulador usam a agenda derivada e continuam sem gravar", async () => {
    for (const mode of ["copilot", "simulator"] as const) {
      const { fake, result } = await runScenario(book(effectiveSchedulingConfig(legacyOff(), ["apt_limpeza"]), mode));
      expect(fake.appointments, mode).toHaveLength(0);
      expect(fake.writes.filter((w) => w.port === "agenda"), mode).toEqual([]);
      expect(result.messages.length, mode).toBeGreaterThan(0);
    }
  });

  it("guardrail mantido: tipo 'só a equipe' fora da lista permitida continua recusado (agora 'permitidos' = tipos ativos da empresa)", async () => {
    const config = effectiveSchedulingConfig(legacyOff(), ["apt_limpeza"]);
    const { fake } = await runScenario({
      ...book(config),
      model: [{ toolCalls: [{ id: "t1", name: "book_appointment", input: { slot_id: "slot:apt_canal:2026-10-27T17:00:00Z", type_id: "apt_canal" } }], stopReason: "tool_use" }],
    });
    expect(fake.appointments).toHaveLength(0);
  });
});
