import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_EXAMPLES,
  MAX_EXAMPLE_CHARS,
  addExample,
  canAddExample,
  cleanExamples,
  examplesCountLabel,
  incompleteExamples,
  moveExample,
  removeExample,
  updateExample,
} from "./agent-examples";

const ex = (n: number) => ({ customer: `Pergunta ${n}`, agent: `Resposta ${n}` });
const list = [ex(1), ex(2), ex(3)];

describe("addExample", () => {
  it("acrescenta um par em branco no fim, sem mexer na lista original", () => {
    const next = addExample(list);
    expect(next).toHaveLength(4);
    expect(next[3]).toEqual({ customer: "", agent: "" });
    expect(list).toHaveLength(3);
  });

  it("respeita o limite de exemplos", () => {
    const full = Array.from({ length: MAX_AGENT_EXAMPLES }, (_, i) => ex(i));
    expect(canAddExample(full)).toBe(false);
    expect(addExample(full)).toHaveLength(MAX_AGENT_EXAMPLES);
    expect(canAddExample(full.slice(1))).toBe(true);
  });
});

describe("removeExample / moveExample", () => {
  it("remove pelo índice", () => {
    expect(removeExample(list, 1).map((e) => e.customer)).toEqual(["Pergunta 1", "Pergunta 3"]);
    expect(removeExample(list, 9)).toEqual(list);
  });

  it("sobe e desce, e não faz nada nas pontas", () => {
    expect(moveExample(list, 1, -1).map((e) => e.customer)).toEqual(["Pergunta 2", "Pergunta 1", "Pergunta 3"]);
    expect(moveExample(list, 1, 1).map((e) => e.customer)).toEqual(["Pergunta 1", "Pergunta 3", "Pergunta 2"]);
    expect(moveExample(list, 0, -1)).toEqual(list);
    expect(moveExample(list, 2, 1)).toEqual(list);
    expect(moveExample(list, 0, -1)).not.toBe(list);
  });
});

describe("updateExample", () => {
  it("troca só o lado escolhido do par escolhido", () => {
    const next = updateExample(list, 1, "agent", "Nova resposta");
    expect(next[1]).toEqual({ customer: "Pergunta 2", agent: "Nova resposta" });
    expect(next[0]).toBe(list[0]);
  });

  it("corta no limite de caracteres por lado", () => {
    const next = updateExample(list, 0, "customer", "x".repeat(MAX_EXAMPLE_CHARS + 50));
    expect(next[0]?.customer).toHaveLength(MAX_EXAMPLE_CHARS);
    expect(addExample([], { customer: "y".repeat(500), agent: "z" })[0]?.customer).toHaveLength(MAX_EXAMPLE_CHARS);
  });
});

describe("incompleteExamples / cleanExamples", () => {
  it("par em branco não é problema (é descartado); par pela metade é", () => {
    const messy = [ex(1), { customer: "", agent: "" }, { customer: "só pergunta", agent: "  " }, { customer: " ", agent: "só resposta" }];
    expect(incompleteExamples(messy)).toEqual([
      { index: 2, side: "agent" },
      { index: 3, side: "customer" },
    ]);
    expect(incompleteExamples(list)).toEqual([]);
  });

  it("limpa: tira os em branco, apara e respeita o máximo", () => {
    expect(cleanExamples([{ customer: " a ", agent: " b " }, { customer: "", agent: "" }])).toEqual([{ customer: "a", agent: "b" }]);
    expect(cleanExamples(Array.from({ length: 15 }, (_, i) => ex(i)))).toHaveLength(MAX_AGENT_EXAMPLES);
  });

  it("rótulo do contador", () => {
    expect(examplesCountLabel(3)).toBe(`3 de ${MAX_AGENT_EXAMPLES} exemplos`);
  });
});
