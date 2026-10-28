export type SearchParams = Record<string, string | string[] | undefined>;

/** Primeiro valor de um parâmetro de busca. */
export function param(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

/** Monta um link mantendo os parâmetros atuais e aplicando as mudanças (null remove). */
export function hrefWith(
  path: string,
  params: SearchParams,
  updates: Record<string, string | number | null>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && first !== "") query.set(key, first);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === "") query.delete(key);
    else query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** "3" → 3; inválido → 1. */
export function pageParam(value: string | undefined) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}
