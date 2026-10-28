import { describe, expect, it } from "vitest";
import { runScenario, type Scenario } from "./harness";
import { scenarios } from "./scenarios";

// Evals determinísticos (§4.4): LLM fake roteirizado. Rodam no CI; regressão em guardrail/handoff/tools falha aqui.

export function assertScenario(scenario: Scenario, outcome: Awaited<ReturnType<typeof runScenario>>, options: { exactCalls: boolean }) {
  const { result, fake, requests, counts } = outcome;
  const e = scenario.expect;
  if (e.handoff !== undefined) expect(result.handoff?.kind ?? null).toBe(e.handoff);
  if (e.intent !== undefined) expect(result.intent).toBe(e.intent);
  if (e.skipped !== undefined) expect(result.skipped).toBe(e.skipped);
  if (e.optOut !== undefined) expect(result.optOut).toBe(e.optOut);
  if (e.tools) {
    const names = result.toolCalls.map((t) => t.tool);
    for (const t of e.tools) expect(names, `tool esperada: ${t}`).toContain(t);
  }
  if (e.noTools) for (const t of e.noTools) expect(result.toolCalls.map((x) => x.tool)).not.toContain(t);
  if (e.blocked) expect([...result.blocked].sort()).toEqual([...e.blocked].sort());
  if (e.flags) for (const f of e.flags) expect(result.flags).toContain(f);
  if (e.messagesNonEmpty) expect(result.messages.length).toBeGreaterThan(0);
  if (e.noMessages) expect(result.messages).toEqual([]);
  if (options.exactCalls) {
    if (e.smartCalls !== undefined) expect(counts().smart).toBe(e.smartCalls);
    if (e.routerCalls !== undefined) expect(counts().router).toBe(e.routerCalls);
  }
  e.check?.(result, fake, requests);
}

describe("evals de agentes (LLM fake roteirizado)", () => {
  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.description}`, async () => {
      assertScenario(scenario, await runScenario(scenario), { exactCalls: true });
    });
  }

  it("cobre os seis tipos de conversa exigidos pelo §4.4", () => {
    const ids = scenarios.map((s) => s.id).join(" ");
    for (const needle of ["agendar", "preco-desconhecido", "injecao", "pede-humano", "irritado", "opt-out"]) {
      expect(ids).toContain(needle);
    }
  });
});
