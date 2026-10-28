import { contactFilterSchema, type ContactFilter } from "@duckzap/contracts/contacts";
import { schema } from "@duckzap/db";
import { and, eq, gte, ilike, inArray, isNull, lte, not, or, sql, type SQL } from "drizzle-orm";
import { inviteCutoff } from "./consent";

const { contacts, consents, contactTags, contactListMembers } = schema;
const DAY_MS = 86_400_000;

/** Escapa `\`, `%` e `_` para a busca ILIKE tratar o texto do usuário como literal. */
export function escapeLike(text: string) {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Filtro vindo do banco (segmento salvo) ou do cliente: sempre revalidado com Zod; inválido vira "sem filtro". */
export function parseFilter(raw: unknown): ContactFilter {
  const parsed = contactFilterSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

function hasConsent(statusCondition: SQL) {
  return sql`exists (select 1 from ${consents} where ${consents.contactId} = ${contacts.id} and ${statusCondition})`;
}

/**
 * Filtro de contatos → condição SQL (Drizzle, valores sempre como parâmetros). É o que avalia segmentos
 * dinâmicos e a busca da tabela. `now` é injetado para o resultado ser testável.
 */
export function buildContactCondition(filter: ContactFilter, now: Date): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];

  if (filter.q) {
    const like = `%${escapeLike(filter.q)}%`;
    const digits = filter.q.replace(/\D/g, "");
    conditions.push(
      or(
        ilike(contacts.name, like),
        ilike(contacts.email, like),
        ilike(contacts.instagram, like),
        digits.length >= 3 ? ilike(contacts.phone, `%${digits}%`) : undefined,
      ),
    );
  }
  if (filter.tagId) {
    conditions.push(
      sql`exists (select 1 from ${contactTags} where ${contactTags.contactId} = ${contacts.id} and ${contactTags.tagId} = ${filter.tagId})`,
    );
  }
  if (filter.isCustomer !== undefined) conditions.push(eq(contacts.isCustomer, filter.isCustomer));
  if (filter.consent) {
    const cutoff = inviteCutoff(now);
    const fresh = sql`(${isNull(consents.inviteSentAt)} or ${gte(consents.inviteSentAt, cutoff)})`;
    switch (filter.consent) {
      case "none":
        conditions.push(sql`not ${hasConsent(sql`true`)}`);
        break;
      case "granted":
      case "denied":
        conditions.push(hasConsent(sql`${consents.status} = ${filter.consent}`));
        break;
      case "pending":
        conditions.push(hasConsent(sql`${consents.status} = 'pending' and ${fresh}`));
        break;
      case "expired":
        conditions.push(hasConsent(sql`(${consents.status} = 'expired' or (${consents.status} = 'pending' and ${not(fresh)}))`));
        break;
    }
  }
  if (filter.createdWithinDays) {
    conditions.push(gte(contacts.createdAt, new Date(now.getTime() - filter.createdWithinDays * DAY_MS)));
  }
  if (filter.inactiveDays) {
    // sem interação há N dias; quem nunca interagiu também entra
    conditions.push(
      or(isNull(contacts.lastInteractionAt), lte(contacts.lastInteractionAt, new Date(now.getTime() - filter.inactiveDays * DAY_MS))),
    );
  }
  if (filter.birthMonth) conditions.push(sql`extract(month from ${contacts.birthDate}) = ${filter.birthMonth}`);

  return and(...conditions);
}

/** Pertencer a uma lista estática (membros) ou a um segmento (filtro salvo). */
export function buildListCondition(list: { id: string; kind: string; filter: unknown }, now: Date): SQL | undefined {
  if (list.kind === "segment") return buildContactCondition(parseFilter(list.filter), now);
  return sql`exists (select 1 from ${contactListMembers} where ${contactListMembers.contactId} = ${contacts.id} and ${contactListMembers.listId} = ${list.id})`;
}

export const idsIn = (ids: readonly string[]) => inArray(contacts.id, [...ids]);
