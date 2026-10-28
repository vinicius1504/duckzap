import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_EXAMPLES,
  FOLLOW_UP_EXTRA_MAX,
  MAX_FOLLOW_UP_STEPS,
  WAIT_LIMITS,
  addStep,
  canAddStep,
  clampAmount,
  defaultFollowUpLayout,
  followUpLayoutSummary,
  fromMinutes,
  isAscending,
  moveStep,
  removeStep,
  setStepAmount,
  setStepUnit,
  stepLabel,
  toMinutes,
  type WaitStep,
} from "./follow-up-layout";

const step = (id: string, amount: number, unit: WaitStep["unit"]): WaitStep => ({ id, amount, unit });

describe("rótulo e conversão de unidade", () => {
  it("escreve 'Após 2 h', 'Após 24 h', 'Após 3 dias'", () => {
    expect(stepLabel(step("a", 30, "minutes"))).toBe("Após 30 min");
    expect(stepLabel(step("a", 2, "hours"))).toBe("Após 2 h");
    expect(stepLabel(step("a", 24, "hours"))).toBe("Após 24 h");
    expect(stepLabel(step("a", 1, "days"))).toBe("Após 1 dia");
    expect(stepLabel(step("a", 3, "days"))).toBe("Após 3 dias");
  });

  it("converte para minutos", () => {
    expect(toMinutes(step("a", 45, "minutes"))).toBe(45);
    expect(toMinutes(step("a", 2, "hours"))).toBe(120);
    expect(toMinutes(step("a", 3, "days"))).toBe(4320);
  });

  it("volta de minutos para o par mais natural, respeitando os limites", () => {
    expect(fromMinutes(120)).toEqual({ amount: 2, unit: "hours" });
    expect(fromMinutes(4320)).toEqual({ amount: 3, unit: "days" });
    expect(fromMinutes(90)).toEqual({ amount: 90, unit: "minutes" });
    expect(fromMinutes(1440)).toEqual({ amount: 1, unit: "days" });
    expect(fromMinutes(60 * 60 * 24 * 60)).toEqual({ amount: 30, unit: "days" });
    expect(fromMinutes(0)).toEqual({ amount: 1, unit: "minutes" });
  });
});

describe("limites", () => {
  it("o número fica entre o mínimo e o máximo da unidade e é inteiro", () => {
    expect(clampAmount(0, "hours")).toBe(1);
    expect(clampAmount(-5, "days")).toBe(1);
    expect(clampAmount(999, "days")).toBe(WAIT_LIMITS.days.max);
    expect(clampAmount(999, "hours")).toBe(WAIT_LIMITS.hours.max);
    expect(clampAmount(2.6, "hours")).toBe(3);
    expect(clampAmount(Number.NaN, "minutes")).toBe(1);
  });

  it("no máximo 5 etapas e 500 caracteres nas instruções extras", () => {
    expect(MAX_FOLLOW_UP_STEPS).toBe(5);
    expect(FOLLOW_UP_EXTRA_MAX).toBe(500);
  });
});

describe("adicionar, remover e mover etapas", () => {
  it("o padrão começa desligado, com 2 etapas e as duas opções ligadas", () => {
    const layout = defaultFollowUpLayout();
    expect(layout.enabled).toBe(false);
    expect(layout.steps.map(stepLabel)).toEqual(["Após 2 h", "Após 1 dia"]);
    expect(layout.respectBusinessHours).toBe(true);
    expect(layout.stopOnReply).toBe(true);
    expect(layout.extraInstructions).toBe("");
  });

  it("adiciona no fim esperando o dobro da anterior; sem etapas começa em 2 h", () => {
    expect(addStep([]).map(stepLabel)).toEqual(["Após 2 h"]);
    expect(addStep([step("a", 2, "hours")]).map(stepLabel)).toEqual(["Após 2 h", "Após 4 h"]);
    expect(addStep([step("a", 1, "days")]).map(stepLabel)).toEqual(["Após 1 dia", "Após 2 dias"]);
  });

  it("cada etapa nova tem id próprio", () => {
    const list = addStep(addStep([]));
    expect(new Set(list.map((s) => s.id)).size).toBe(2);
  });

  it("não passa de 5 etapas", () => {
    let list: WaitStep[] = [];
    for (let i = 0; i < 8; i += 1) list = addStep(list);
    expect(list).toHaveLength(5);
    expect(canAddStep(list)).toBe(false);
    expect(addStep(list)).toEqual(list);
    expect(canAddStep(list.slice(1))).toBe(true);
  });

  it("remove pelo id", () => {
    const list = [step("a", 2, "hours"), step("b", 1, "days")];
    expect(removeStep(list, "a")).toEqual([step("b", 1, "days")]);
    expect(removeStep(list, "x")).toEqual(list);
  });

  it("sobe e desce; nas pontas não faz nada; não altera a lista original", () => {
    const list = [step("a", 2, "hours"), step("b", 1, "days"), step("c", 3, "days")];
    expect(moveStep(list, "b", -1).map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(moveStep(list, "b", 1).map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(moveStep(list, "a", -1).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(moveStep(list, "c", 1).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(moveStep(list, "x", 1).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(list.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("troca o número e a unidade respeitando os limites", () => {
    const list = [step("a", 2, "hours")];
    expect(setStepAmount(list, "a", 500)[0]).toEqual(step("a", 72, "hours"));
    expect(setStepAmount(list, "a", 0)[0]).toEqual(step("a", 1, "hours"));
    expect(setStepUnit([step("a", 100, "hours")].map((s) => ({ ...s, amount: 70 })), "a", "days")[0]).toEqual(step("a", 30, "days"));
    expect(setStepUnit(list, "a", "minutes")[0]).toEqual(step("a", 2, "minutes"));
  });

  it("avisa quando as esperas não estão em ordem crescente (reordenar continua livre)", () => {
    expect(isAscending([step("a", 2, "hours"), step("b", 24, "hours"), step("c", 3, "days")])).toBe(true);
    expect(isAscending([step("a", 1, "days"), step("b", 2, "hours")])).toBe(false);
    expect(isAscending([])).toBe(true);
  });

  it("resume o cartão fechado", () => {
    const layout = defaultFollowUpLayout();
    expect(followUpLayoutSummary(layout)).toBe("Desligado na prévia · Após 2 h, Após 1 dia");
    expect(followUpLayoutSummary({ ...layout, enabled: true, steps: [] })).toBe("Ligado na prévia · sem etapas");
  });
});

describe("exemplos ilustrativos", () => {
  it("são 1 ou 2 mensagens curtas (1 a 3 frases), cordiais, sem emoji e sem dizer que é automático", () => {
    expect(FOLLOW_UP_EXAMPLES.length).toBeGreaterThanOrEqual(1);
    expect(FOLLOW_UP_EXAMPLES.length).toBeLessThanOrEqual(2);
    for (const text of FOLLOW_UP_EXAMPLES) {
      const sentences = text.split(/[.!?]+\s*/).filter(Boolean);
      expect(sentences.length).toBeGreaterThanOrEqual(1);
      expect(sentences.length).toBeLessThanOrEqual(3);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/autom[aá]tic|rob[oô]|\bIA\b|intelig[eê]ncia artificial/i);
    }
  });
});
