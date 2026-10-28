import { describe, expect, it } from "vitest";
import type { ProviderContact } from "../../lib/messaging";
import { buildWhatsappCandidates } from "./whatsapp-import";

// Montagem da lista de candidatos (sem banco). Todos os números e nomes são inventados.

const person = (digits: string, name: string | null = null): ProviderContact => ({ jid: `${digits}@s.whatsapp.net`, kind: "person", phoneDigits: digits, name });
const group: ProviderContact = { jid: "1203630000@g.us", kind: "group", phoneDigits: null, name: "Grupo" };
const hidden: ProviderContact = { jid: "9876543210@lid", kind: "hidden", phoneDigits: null, name: null };
const other: ProviderContact = { jid: "status@broadcast", kind: "other", phoneDigits: null, name: null };

describe("buildWhatsappCandidates", () => {
  it("telefone é + e os dígitos do JID (12 e 13 dígitos), como a entrada de mensagens grava", () => {
    const { candidates } = buildWhatsappCandidates([person("556799990000", "Bia"), person("5567999990001", "Caio")], null);
    expect(candidates).toEqual([
      { phone: "+556799990000", name: "Bia" },
      { phone: "+5567999990001", name: "Caio" },
    ]);
  });

  it("conta grupos, ocultos e outros; a soma fecha com o total", () => {
    const found = [person("5567999990001", "A"), person("5567999990002"), group, group, hidden, other, person("5567999990001", "A")];
    const out = buildWhatsappCandidates(found, null);
    expect(out.groups).toBe(2);
    expect(out.hidden).toBe(1);
    expect(out.other).toBe(2); // status + o repetido
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates.length + out.groups + out.hidden + out.other).toBe(found.length);
  });

  it("repetido por telefone: fica um só, preferindo o que tem nome", () => {
    const { candidates, other: dropped } = buildWhatsappCandidates([person("5567999990001"), person("5567999990001", "Com Nome"), person("5567999990001", "Outro")], null);
    expect(candidates).toEqual([{ phone: "+5567999990001", name: "Com Nome" }]);
    expect(dropped).toBe(2);
  });

  it("exclui o próprio número do canal", () => {
    const out = buildWhatsappCandidates([person("5567999990001", "Eu"), person("5567999990002", "Outro")], "+5567999990001");
    expect(out.candidates).toEqual([{ phone: "+5567999990002", name: "Outro" }]);
    expect(out.other).toBe(1);
  });

  it("número curto demais para ser telefone (8–9 dígitos) não vira candidato", () => {
    const out = buildWhatsappCandidates([person("12345678", "Curto"), person("5567999990003", "Ok")], null);
    expect(out.candidates.map((c) => c.phone)).toEqual(["+5567999990003"]);
    expect(out.other).toBe(1);
  });

  it("ordena por nome (sem acento/caixa), vazios no fim, desempate pelo telefone", () => {
    const { candidates } = buildWhatsappCandidates(
      [person("5567999990005"), person("5567999990004", "Zeca"), person("5567999990003", "álvaro"), person("5567999990002", "Bruna"), person("5567999990001")],
      null,
    );
    expect(candidates.map((c) => c.name)).toEqual(["álvaro", "Bruna", "Zeca", "", ""]);
    expect(candidates.slice(3).map((c) => c.phone)).toEqual(["+5567999990001", "+5567999990005"]);
  });

  it("nome é aparado e limitado a 120 caracteres", () => {
    const { candidates } = buildWhatsappCandidates([person("5567999990001", `  ${"x".repeat(200)}  `)], null);
    expect(candidates[0]!.name).toHaveLength(120);
  });
});
