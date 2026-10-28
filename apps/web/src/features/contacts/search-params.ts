import type { ConsentFilter, ContactFilter, ContactListQuery } from "@duckzap/contracts/contacts";
import { parseAsInteger, parseAsString, parseAsStringLiteral } from "nuqs/server";
import { z } from "zod";

// Estado da tela de Clientes na URL. Chaves e valores em pt-BR (?aba=listas&disparos=aceita&pagina=2);
// aqui viram o filtro do contrato. Usado pelo server (page.tsx) e pelo client (nuqs).

export const PAGE_SIZE = 10;

export const tabs = ["todos", "listas", "etiquetas"] as const;
export type ContactsTab = (typeof tabs)[number];

export const consentParamKeys = ["aceita", "pendente", "recusou", "expirou", "sem-convite"] as const;
export type ConsentParam = (typeof consentParamKeys)[number];

export const consentParam = {
  aceita: "granted",
  pendente: "pending",
  recusou: "denied",
  expirou: "expired",
  "sem-convite": "none",
} as const satisfies Record<ConsentParam, ConsentFilter>;

export const customerParams = ["sim", "nao"] as const;
export const createdParams = ["7d", "30d", "90d"] as const;
export const inactiveParams = ["30d", "90d", "180d"] as const;

/** Parsers do nuqs (client). `shallow: false` para o server recarregar os dados. */
export const contactsParsers = {
  aba: parseAsStringLiteral(tabs).withDefault("todos"),
  q: parseAsString.withDefault(""),
  etiqueta: parseAsString,
  cliente: parseAsStringLiteral(customerParams),
  disparos: parseAsStringLiteral(consentParamKeys),
  criado: parseAsStringLiteral(createdParams),
  inativo: parseAsStringLiteral(inactiveParams),
  lista: parseAsString,
  pagina: parseAsInteger.withDefault(1),
  ficha: parseAsString,
};

const one = z.preprocess((v) => (Array.isArray(v) ? v[0] : v), z.string().optional());
const days = (allowed: readonly string[]) =>
  one.transform((v) => (v && allowed.includes(v) ? Number(v.replace("d", "")) : undefined));

const searchSchema = z.object({
  aba: one.pipe(z.enum(tabs).optional()).catch(undefined),
  q: one.catch(undefined),
  etiqueta: one.catch(undefined),
  cliente: one.pipe(z.enum(customerParams).optional()).catch(undefined),
  disparos: one.pipe(z.enum(consentParamKeys).optional()).catch(undefined),
  criado: days(createdParams).catch(undefined),
  inativo: days(inactiveParams).catch(undefined),
  lista: one.catch(undefined),
  pagina: one
    .transform((v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 ? n : undefined;
    })
    .catch(undefined),
  ficha: one.catch(undefined),
});

export type RawSearchParams = Record<string, string | string[] | undefined>;

export function parseContactsSearch(raw: RawSearchParams) {
  const p = searchSchema.parse(raw);
  const query: ContactListQuery = {
    q: p.q?.trim() || undefined,
    tagId: p.etiqueta || undefined,
    isCustomer: p.cliente === undefined ? undefined : p.cliente === "sim",
    consent: p.disparos ? consentParam[p.disparos] : undefined,
    createdWithinDays: p.criado === 7 || p.criado === 30 || p.criado === 90 ? p.criado : undefined,
    inactiveDays: p.inativo === 30 || p.inativo === 90 || p.inativo === 180 ? p.inativo : undefined,
    listId: p.lista || undefined,
    page: p.pagina ?? 1,
    pageSize: PAGE_SIZE,
  };
  return { tab: p.aba ?? "todos", query, contactId: p.ficha || null };
}

/** Filtro salvo num segmento a partir dos filtros atuais (sem busca livre, lista e página). */
export function filterFromQuery(query: ContactListQuery): ContactFilter {
  const filter: ContactFilter = {};
  if (query.tagId) filter.tagId = query.tagId;
  if (query.isCustomer !== undefined) filter.isCustomer = query.isCustomer;
  if (query.consent) filter.consent = query.consent;
  if (query.createdWithinDays) filter.createdWithinDays = query.createdWithinDays;
  if (query.inactiveDays) filter.inactiveDays = query.inactiveDays;
  if (query.q) filter.q = query.q;
  return filter;
}

export function hasActiveFilters(query: ContactListQuery) {
  return Boolean(
    query.q ||
      query.tagId ||
      query.isCustomer !== undefined ||
      query.consent ||
      query.createdWithinDays ||
      query.inactiveDays ||
      query.listId,
  );
}
