import { contactFilterSchema } from "@duckzap/contracts/contacts";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildContactCondition, escapeLike, parseFilter } from "./filter";

// Forma da consulta que avalia segmentos dinâmicos: tudo parametrizado (nada de SQL por string).
const dialect = new PgDialect({ casing: "snake_case" });
const NOW = new Date("2025-06-15T12:00:00Z");
const render = (filter: Parameters<typeof buildContactCondition>[0]) => {
  const condition = buildContactCondition(filter, NOW);
  return condition ? dialect.sqlToQuery(condition) : null;
};

describe("filtro de contatos → SQL", () => {
  it("filtro vazio não gera condição", () => {
    expect(render({})).toBeNull();
  });

  it("busca: ILIKE em nome, e-mail e Instagram + telefone só com 3+ dígitos; texto sempre como parâmetro", () => {
    const q = render({ q: "Maria 67 99" });
    expect(q?.sql).toMatch(/"contacts"\."name" ilike \$1/);
    expect(q?.sql).toMatch(/"contacts"\."email" ilike/);
    expect(q?.sql).toMatch(/"contacts"\."instagram" ilike/);
    expect(q?.sql).toMatch(/"contacts"\."phone" ilike/);
    expect(q?.params).toContain("%Maria 67 99%");
    expect(q?.params).toContain("%6799%");
    expect(q?.sql).not.toContain("Maria");

    const noPhone = render({ q: "ana" });
    expect(noPhone?.sql).not.toMatch(/"contacts"\."phone"/);
  });

  it("neutraliza curingas do LIKE e tentativa de injeção fica só como parâmetro", () => {
    expect(escapeLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");
    const evil = "x'; drop table contacts; --";
    const q = render({ q: evil });
    expect(q?.sql).not.toContain("drop table");
    expect(q?.params.some((p) => typeof p === "string" && p.includes("drop table"))).toBe(true);
  });

  it("etiqueta, cliente e mês de aniversário", () => {
    const tag = "0190b3a0-0000-7000-8000-000000000001";
    const q = render({ tagId: tag, isCustomer: true, birthMonth: 4 });
    expect(q?.sql).toMatch(/exists \(select 1 from "contact_tags"/);
    expect(q?.sql).toMatch(/"contacts"\."is_customer" = \$/);
    expect(q?.sql).toMatch(/extract\(month from "contacts"\."birth_date"\) = \$/);
    expect(q?.params).toEqual(expect.arrayContaining([tag, true, 4]));
  });

  it("consentimento: none = sem linha; pending/expired consideram o prazo de 7 dias", () => {
    expect(render({ consent: "none" })?.sql).toMatch(/not exists \(select 1 from "consents"/);
    const granted = render({ consent: "granted" });
    expect(granted?.sql).toMatch(/"consents"\."status" = \$/);
    expect(granted?.params).toContain("granted");
    const pending = render({ consent: "pending" });
    expect(pending?.sql).toMatch(/"consents"\."invite_sent_at" is null or "consents"\."invite_sent_at" >= \$/);
    const cutoff = new Date(NOW.getTime() - 7 * 86_400_000).toISOString();
    expect(pending?.params.map((p) => (p instanceof Date ? p.toISOString() : p))).toContain(cutoff);
    expect(render({ consent: "expired" })?.sql).toMatch(/'expired'/);
  });

  it("criado nos últimos N dias e sem interação há N dias usam datas relativas ao 'agora' injetado", () => {
    const created = render({ createdWithinDays: 30 });
    expect(created?.sql).toMatch(/"contacts"\."created_at" >= \$1/);
    expect(created?.params.map((p) => (p instanceof Date ? p.toISOString() : p))).toEqual([new Date(NOW.getTime() - 30 * 86_400_000).toISOString()]);

    const inactive = render({ inactiveDays: 90 });
    expect(inactive?.sql).toMatch(/"contacts"\."last_interaction_at" is null or "contacts"\."last_interaction_at" <= \$/);
  });

  it("combina condições com AND", () => {
    const q = render({ isCustomer: false, createdWithinDays: 7 });
    expect(q?.sql).toMatch(/ and /);
  });
});

describe("filtro salvo (segmento) é validado com Zod", () => {
  it("aceita filtro válido", () => {
    expect(contactFilterSchema.safeParse({ consent: "granted", inactiveDays: 90 }).success).toBe(true);
  });
  it("rejeita valores fora do contrato", () => {
    expect(contactFilterSchema.safeParse({ consent: "tudo" }).success).toBe(false);
    expect(contactFilterSchema.safeParse({ inactiveDays: 5 }).success).toBe(false);
    expect(contactFilterSchema.safeParse({ birthMonth: 13 }).success).toBe(false);
    expect(contactFilterSchema.safeParse({ q: "a".repeat(101) }).success).toBe(false);
  });
  it("parseFilter descarta lixo do banco em vez de montar SQL com ele", () => {
    expect(parseFilter({ consent: "'; drop table x; --" })).toEqual({});
    expect(parseFilter(null)).toEqual({});
    expect(parseFilter({ isCustomer: true, extra: "ignorado" })).toEqual({ isCustomer: true });
  });
});
