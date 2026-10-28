import { shuffle, type Rng } from "./rng";

// Público (§5.7 item 1). Só `consent = granted`; opt-out bloqueia para sempre; duplicados saem; ordem embaralhada com
// prioridade para quem conversou nos últimos 90 dias. Puro: o service entrega as linhas já lidas do banco.

export type ConsentKind = "granted" | "denied" | "none";

export type AudienceRow = {
  contactId: string;
  phone: string | null;
  consent: ConsentKind;
  createdAt: Date;
  /** Conversou com a empresa nos últimos 90 dias. */
  recent: boolean;
};

export type AudienceBreakdown = {
  total: number;
  optedIn: number;
  notOptedIn: number;
  optedOut: number;
  duplicates: number;
  recentlyActive: number;
};

/**
 * Chave de duplicidade do telefone. No Brasil o mesmo celular aparece com e sem o 9º dígito
 * (+55 67 99812-3456 e +55 67 9812-3456): a chave tira esse 9, então os dois colidem.
 */
export function dedupeKey(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length === 13 && digits[4] === "9") return `${digits.slice(0, 4)}${digits.slice(5)}`;
  return digits;
}

const consentRank: Record<ConsentKind, number> = { granted: 0, none: 1, denied: 2 };

/**
 * Classifica o público. Ordem de precedência (cada pessoa cai em UM grupo, e a soma fecha com `total`):
 * 1. saiu (denied)  2. sem aceite (não deu opt-in)  3. sem telefone (não alcançável; entra em "sem aceite")
 * 4. duplicado (outro contato com o mesmo número já está no público; fica o mais antigo)  5. elegível.
 */
export function classifyAudience(rows: readonly AudienceRow[]): { eligible: AudienceRow[]; breakdown: AudienceBreakdown } {
  let optedOut = 0;
  let notOptedIn = 0;
  let duplicates = 0;
  const granted: AudienceRow[] = [];
  for (const row of rows) {
    if (row.consent === "denied") optedOut++;
    else if (row.consent !== "granted" || !row.phone) notOptedIn++;
    else granted.push(row);
  }
  const keep = new Map<string, AudienceRow>();
  for (const row of [...granted].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.contactId.localeCompare(b.contactId))) {
    const key = dedupeKey(row.phone as string);
    if (keep.has(key)) duplicates++;
    else keep.set(key, row);
  }
  const eligible = [...keep.values()];
  return {
    eligible,
    breakdown: {
      total: rows.length,
      optedIn: eligible.length,
      notOptedIn,
      optedOut,
      duplicates,
      recentlyActive: eligible.filter((r) => r.recent).length,
    },
  };
}

/** Ordem de envio: quem conversou nos últimos 90 dias primeiro, cada grupo embaralhado. */
export function orderAudience<T extends { recent: boolean }>(rows: readonly T[], rng: Rng): T[] {
  return [...shuffle(rows.filter((r) => r.recent), rng), ...shuffle(rows.filter((r) => !r.recent), rng)];
}

export { consentRank };
