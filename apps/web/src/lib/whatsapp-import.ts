import { WHATSAPP_IMPORT_MAX_ROWS, type WhatsappCandidate, type WhatsappImportPreview } from "@duckzap/contracts/contacts";

// Lógica pura da tela "Importar do WhatsApp": busca, ordem, seleção e o que vai para o servidor. Sem React.

/** Nome usado quando a pessoa deixa um contato sem nome na revisão. */
export const NO_NAME_FALLBACK = "Sem nome";

export const NAME_MAX_LENGTH = 120;

/** Sem acento e em minúsculas, para a busca achar "joao" em "João". */
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/**
 * Ordem da revisão: novos antes dos já cadastrados; entre os novos, os sem nome primeiro (pedem atenção), depois A–Z.
 * Usa só o que o WhatsApp trouxe (não o nome editado), para a linha não pular de lugar enquanto a pessoa digita.
 */
export function sortCandidates(candidates: readonly WhatsappCandidate[]): WhatsappCandidate[] {
  const collator = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });
  return [...candidates].sort((a, b) => {
    if (a.existing !== b.existing) return a.existing ? 1 : -1;
    const aEmpty = a.name.trim() === "";
    const bEmpty = b.name.trim() === "";
    if (aEmpty !== bEmpty) return aEmpty ? -1 : 1;
    return collator.compare(a.name, b.name) || a.phone.localeCompare(b.phone);
  });
}

/** Filtra por nome (como veio do WhatsApp) ou por trecho do telefone. Busca vazia devolve tudo. */
export function filterCandidates(candidates: readonly WhatsappCandidate[], query: string): WhatsappCandidate[] {
  const text = normalizeText(query);
  if (!text) return [...candidates];
  const digits = query.replace(/\D/g, "");
  return candidates.filter((c) => normalizeText(c.name).includes(text) || (digits !== "" && c.phone.replace(/\D/g, "").includes(digits)));
}

/** Padrão: todos os novos marcados; os já cadastrados começam desmarcados. */
export function initialSelection(candidates: readonly WhatsappCandidate[]): Set<string> {
  return new Set(candidates.filter((c) => !c.existing).map((c) => c.phone));
}

/** Marca ou desmarca vários de uma vez (ex.: tudo o que o filtro mostra), sem alterar o resto. */
export function setMany(selected: ReadonlySet<string>, phones: readonly string[], checked: boolean): Set<string> {
  const next = new Set(selected);
  for (const phone of phones) {
    if (checked) next.add(phone);
    else next.delete(phone);
  }
  return next;
}

/** Nome mostrado/enviado: o que a pessoa escreveu, ou o que veio do WhatsApp. */
export function displayName(candidate: WhatsappCandidate, edits: Readonly<Record<string, string>>): string {
  return edits[candidate.phone] ?? candidate.name;
}

export type SelectionStats = {
  selected: number;
  selectedNew: number;
  selectedExisting: number;
  /** Marcados que ainda estão sem nome (viram "Sem nome" se a pessoa não escrever). */
  selectedWithoutName: number;
};

export function selectionStats(
  candidates: readonly WhatsappCandidate[],
  selected: ReadonlySet<string>,
  edits: Readonly<Record<string, string>>,
): SelectionStats {
  const stats: SelectionStats = { selected: 0, selectedNew: 0, selectedExisting: 0, selectedWithoutName: 0 };
  for (const c of candidates) {
    if (!selected.has(c.phone)) continue;
    stats.selected += 1;
    if (c.existing) stats.selectedExisting += 1;
    else stats.selectedNew += 1;
    if (displayName(c, edits).trim() === "") stats.selectedWithoutName += 1;
  }
  return stats;
}

export type CommitRows = { ok: true; rows: { phone: string; name: string }[] } | { ok: false; error: string };

/**
 * Monta a seleção final para o servidor: só telefones da prévia, uma vez cada, na ordem da prévia, com o nome limpo
 * (espaços ajustados, até 120 letras; vazio vira "Sem nome").
 */
export function buildCommitRows(
  candidates: readonly WhatsappCandidate[],
  selected: ReadonlySet<string>,
  edits: Readonly<Record<string, string>>,
): CommitRows {
  const seen = new Set<string>();
  const rows: { phone: string; name: string }[] = [];
  for (const c of candidates) {
    if (!selected.has(c.phone) || seen.has(c.phone)) continue;
    seen.add(c.phone);
    const name = displayName(c, edits).replace(/\s+/g, " ").trim().slice(0, NAME_MAX_LENGTH).trim();
    rows.push({ phone: c.phone, name: name || NO_NAME_FALLBACK });
  }
  if (rows.length === 0) return { ok: false, error: "Marque ao menos um contato." };
  if (rows.length > WHATSAPP_IMPORT_MAX_ROWS) {
    return { ok: false, error: `Dá para importar até ${WHATSAPP_IMPORT_MAX_ROWS.toLocaleString("pt-BR")} contatos por vez. Desmarque alguns e importe o resto depois.` };
  }
  return { ok: true, rows };
}

export function pluralize(n: number, singular: string, plural: string): string {
  return `${n.toLocaleString("pt-BR")} ${n === 1 ? singular : plural}`;
}

/** "Encontramos 1.230 pessoas" (ou "1 pessoa"). */
export function foundHeadline(summary: WhatsappImportPreview["summary"]): string {
  return `Encontramos ${pluralize(summary.people, "pessoa", "pessoas")}`;
}

/** "19 grupos e 46 contatos sem número visível não entram." — null quando nada ficou de fora. */
export function exclusionText(summary: WhatsappImportPreview["summary"]): string | null {
  const parts: string[] = [];
  if (summary.groups > 0) parts.push(pluralize(summary.groups, "grupo", "grupos"));
  if (summary.hidden > 0) parts.push(pluralize(summary.hidden, "contato sem número visível", "contatos sem número visível"));
  if (summary.other > 0) parts.push(pluralize(summary.other, "outro item que não é pessoa", "outros itens que não são pessoas"));
  if (parts.length === 0) return null;
  const total = summary.groups + summary.hidden + summary.other;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
  return `${list} ${total === 1 ? "não entra" : "não entram"}.`;
}
