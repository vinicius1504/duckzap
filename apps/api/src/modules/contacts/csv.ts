import type { ImportField } from "@duckzap/contracts/contacts";

// CSV de entrada (importação) e de saída (exportação). Sem dependências: XLSX não é suportado nesta fase.

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;

/** Descobre o separador pela primeira linha (fora de aspas): `;` (Excel pt-BR), `,` ou tab. */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ";": 0, ",": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  const [best] = Object.entries(counts).sort((x, y) => y[1] - x[1]);
  return best && best[1] > 0 ? best[0] : ",";
}

/** Parser RFC 4180 simples: aspas duplas, separador configurável, CRLF/LF, linhas vazias ignoradas. */
export function parseCsv(input: string, delimiter = detectDelimiter(input)): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === "\n") endRow();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

function norm(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Sugere o campo pelo título da coluna. */
export function suggestField(header: string): ImportField {
  const h = norm(header);
  if (/\b(e ?mail|email)\b/.test(h) || h === "mail") return "email";
  if (/(telefone|celular|whats|fone|phone|tel|contato)/.test(h)) return "phone";
  if (/(nascimento|aniversario|birth)/.test(h)) return "birthDate";
  if (/(obs|nota|anotac|coment)/.test(h)) return "note";
  if (/(nome|name|cliente|paciente)/.test(h)) return "name";
  return "ignore";
}

export type ImportSheet = {
  columns: { key: string; header: string; suggested: ImportField }[];
  rows: Record<string, string>[];
};

/** CSV → colunas (chaves c1…cN, estáveis mesmo com cabeçalhos repetidos) + linhas. */
export function buildImportSheet(text: string): ImportSheet {
  const table = parseCsv(text);
  const [header = [], ...body] = table;
  const columns = header.map((h, i) => ({ key: `c${i + 1}`, header: h.trim() || `Coluna ${i + 1}`, suggested: suggestField(h) }));
  // uma sugestão por campo: a primeira coluna que casa fica, as outras viram "ignorar"
  const seen = new Set<ImportField>();
  for (const column of columns) {
    if (column.suggested === "ignore") continue;
    if (seen.has(column.suggested)) column.suggested = "ignore";
    else seen.add(column.suggested);
  }
  const rows = body.map((cells) => Object.fromEntries(columns.map((c, i) => [c.key, (cells[i] ?? "").trim()])));
  return { columns, rows };
}

/** Aceita AAAA-MM-DD e DD/MM/AAAA; qualquer outra coisa (ou data impossível) vira null. */
export function parseBirthDate(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])] as [number, number, number];
  else if (br) [d, m, y] = [Number(br[1]), Number(br[2]), Number(br[3])] as [number, number, number];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  if (y < 1900 || date.getTime() > Date.now()) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const cleanEmail = (value: string | undefined) => {
  const v = value?.trim().toLowerCase();
  return v && EMAIL.test(v) && v.length <= 254 ? v : null;
};

// Exportação --------------------------------------------------------------------------------------------------

/**
 * Célula de CSV segura: neutraliza injeção de fórmula (= + - @, e TAB/CR) prefixando uma aspa simples e
 * cita o valor quando tiver `"`, `;` ou quebra de linha.
 */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[";\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Linhas → texto CSV com `;` e BOM (o Excel pt-BR abre com acentos e colunas certas). */
export function buildCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows].map((cells) => cells.map(csvCell).join(";"));
  return `\uFEFF${lines.join("\r\n")}`;
}
