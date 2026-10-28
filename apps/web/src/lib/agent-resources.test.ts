import { agentToolSchema, type AgentConfig } from "@duckzap/contracts/agents";
import { describe, expect, it } from "vitest";
import { HIDDEN_TOOLS, setToolEnabled, standaloneTools } from "./agent-resources";

const config: AgentConfig = {
  name: "Duda",
  profile: { description: "", tone: "friendly", companySummary: "" },
  knowledge: { productsAndServices: "", faq: "" },
  behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 6 },
  followUp: { enabled: true, steps: [{ id: "s1", delayMinutes: 120, mode: "ai", content: "Retoma" }], respectBusinessHours: true, stopOnReply: true },
  scheduling: { canBook: true, appointmentTypeIds: ["t1"] },
  advanced: { prompt: "", tools: ["search_knowledge", "request_human", "book_appointment", "list_available_slots", "schedule_followup"] },
};

describe("Ferramentas da IA", () => {
  it("não mostra as ferramentas de agenda (ver horários, marcar, remarcar) nem a de retomada", () => {
    const shown = standaloneTools(agentToolSchema.options);
    expect(shown).toEqual(["search_knowledge", "update_contact_fields", "add_tag", "request_human"]);
    for (const hidden of HIDDEN_TOOLS) expect(shown).not.toContain(hidden);
    expect([...shown, ...HIDDEN_TOOLS].sort()).toEqual([...agentToolSchema.options].sort());
  });

  it("liga e desliga uma ferramenta, sem duplicar; 'chamar uma pessoa' é sempre ligada", () => {
    const on = setToolEnabled(config, "add_tag", true);
    expect(on.advanced.tools).toContain("add_tag");
    expect(setToolEnabled(on, "add_tag", true).advanced.tools.filter((t) => t === "add_tag")).toHaveLength(1);
    expect(setToolEnabled(on, "add_tag", false).advanced.tools).not.toContain("add_tag");
    expect(setToolEnabled(config, "request_human", false)).toBe(config);
  });

  it("as ferramentas escondidas e os campos de agenda e follow-up da config ficam como estão", () => {
    for (const hidden of HIDDEN_TOOLS) {
      expect(setToolEnabled(config, hidden, false)).toBe(config);
      expect(setToolEnabled(config, hidden, true)).toBe(config);
    }
    const next = setToolEnabled(config, "search_knowledge", false);
    expect(next.advanced.tools).toEqual(["request_human", "book_appointment", "list_available_slots", "schedule_followup"]);
    expect(next.scheduling).toBe(config.scheduling);
    expect(next.followUp).toBe(config.followUp);
  });

  it("não altera a config original", () => {
    const before = JSON.stringify(config);
    setToolEnabled(config, "add_tag", true);
    expect(JSON.stringify(config)).toBe(before);
  });
});
