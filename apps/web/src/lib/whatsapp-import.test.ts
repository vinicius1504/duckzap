import { WHATSAPP_IMPORT_MAX_ROWS, type WhatsappCandidate } from "@duckzap/contracts/contacts";
import { describe, expect, it } from "vitest";
import {
  NO_NAME_FALLBACK,
  buildCommitRows,
  exclusionText,
  filterCandidates,
  foundHeadline,
  initialSelection,
  normalizeText,
  selectionStats,
  setMany,
  sortCandidates,
} from "./whatsapp-import";

const c = (phone: string, name: string, existing = false): WhatsappCandidate => ({ phone, name, existing });

const list = [
  c("+5567998123456", "João Silva"),
  c("+5567991111111", ""),
  c("+5511988887777", "Ana Paula", true),
  c("+5567992222222", "bruno"),
  c("+5567993333333", "Ágatha"),
];

const summary = { found: 100, people: 5, existing: 1, groups: 19, hidden: 46, other: 0, noName: 1 };

describe("normalizeText", () => {
  it("tira acento e caixa", () => {
    expect(normalizeText("  João  ")).toBe("joao");
  });
});

describe("sortCandidates", () => {
  it("novos primeiro, sem nome no topo, depois A–Z; já cadastrados no fim", () => {
    expect(sortCandidates(list).map((x) => x.phone)).toEqual([
      "+5567991111111", // sem nome
      "+5567993333333", // Ágatha
      "+5567992222222", // bruno
      "+5567998123456", // João
      "+5511988887777", // já cadastrado
    ]);
  });
  it("não altera a lista original", () => {
    const copy = [...list];
    sortCandidates(list);
    expect(list).toEqual(copy);
  });
});

describe("filterCandidates", () => {
  it("busca vazia devolve tudo", () => {
    expect(filterCandidates(list, "  ")).toHaveLength(5);
  });
  it("acha por nome sem acento", () => {
    expect(filterCandidates(list, "joao").map((x) => x.name)).toEqual(["João Silva"]);
    expect(filterCandidates(list, "agatha")).toHaveLength(1);
  });
  it("acha por trecho do telefone, com ou sem formatação", () => {
    expect(filterCandidates(list, "99812")).toHaveLength(1);
    expect(filterCandidates(list, "(67) 99111")).toHaveLength(1);
  });
  it("nome sem dígitos não casa com telefone", () => {
    expect(filterCandidates(list, "zzz")).toHaveLength(0);
  });
});

describe("seleção", () => {
  it("começa com os novos marcados e os já cadastrados não", () => {
    const sel = initialSelection(list);
    expect(sel.size).toBe(4);
    expect(sel.has("+5511988887777")).toBe(false);
  });
  it("setMany marca/desmarca só o que foi passado", () => {
    const sel = initialSelection(list);
    const off = setMany(sel, ["+5567998123456", "+5567991111111"], false);
    expect(off.size).toBe(2);
    expect(sel.size).toBe(4); // imutável
    const on = setMany(off, ["+5511988887777"], true);
    expect(on.has("+5511988887777")).toBe(true);
    expect(on.size).toBe(3);
  });
  it("selectionStats separa novos, já cadastrados e sem nome (considerando edições)", () => {
    const sel = setMany(initialSelection(list), ["+5511988887777"], true);
    expect(selectionStats(list, sel, {})).toEqual({ selected: 5, selectedNew: 4, selectedExisting: 1, selectedWithoutName: 1 });
    expect(selectionStats(list, sel, { "+5567991111111": "Carla" }).selectedWithoutName).toBe(0);
    expect(selectionStats(list, sel, { "+5567998123456": "   " }).selectedWithoutName).toBe(2);
  });
});

describe("buildCommitRows", () => {
  it("devolve só os marcados, na ordem da prévia, com o nome editado e limpo", () => {
    const sel = new Set(["+5567992222222", "+5567991111111"]);
    const res = buildCommitRows(list, sel, { "+5567992222222": "  Bruno   Souza ", "+5567991111111": "" });
    expect(res).toEqual({
      ok: true,
      rows: [
        { phone: "+5567991111111", name: NO_NAME_FALLBACK },
        { phone: "+5567992222222", name: "Bruno Souza" },
      ],
    });
  });
  it("ignora telefones que não vieram da prévia", () => {
    const res = buildCommitRows(list, new Set(["+5500000000000", "+5567992222222"]), {});
    expect(res.ok && res.rows.map((r) => r.phone)).toEqual(["+5567992222222"]);
  });
  it("corta o nome em 120 letras", () => {
    const res = buildCommitRows(list, new Set(["+5567992222222"]), { "+5567992222222": "a".repeat(300) });
    expect(res.ok && res.rows[0]?.name).toHaveLength(120);
  });
  it("erro sem nada marcado", () => {
    expect(buildCommitRows(list, new Set(), {})).toEqual({ ok: false, error: "Marque ao menos um contato." });
  });
  it("erro acima do limite do contrato", () => {
    const many = Array.from({ length: WHATSAPP_IMPORT_MAX_ROWS + 1 }, (_, i) => c(`+55119${String(i).padStart(8, "0")}`, "x"));
    const res = buildCommitRows(many, new Set(many.map((x) => x.phone)), {});
    expect(res.ok).toBe(false);
  });
});

describe("textos do resumo", () => {
  it("foundHeadline no singular e plural", () => {
    expect(foundHeadline({ ...summary, people: 1 })).toBe("Encontramos 1 pessoa");
    expect(foundHeadline({ ...summary, people: 1230 })).toBe("Encontramos 1.230 pessoas");
  });
  it("exclusionText junta grupos e ocultos", () => {
    expect(exclusionText(summary)).toBe("19 grupos e 46 contatos sem número visível não entram.");
  });
  it("exclusionText com três partes e singular", () => {
    expect(exclusionText({ ...summary, groups: 2, hidden: 1, other: 3 })).toBe(
      "2 grupos, 1 contato sem número visível e 3 outros itens que não são pessoas não entram.",
    );
    expect(exclusionText({ ...summary, groups: 1, hidden: 0, other: 0 })).toBe("1 grupo não entra.");
  });
  it("exclusionText é null quando nada ficou de fora", () => {
    expect(exclusionText({ ...summary, groups: 0, hidden: 0, other: 0 })).toBeNull();
  });
});
