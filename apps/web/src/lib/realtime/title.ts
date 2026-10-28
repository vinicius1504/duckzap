const PREFIX = /^\(\d+\+?\)\s+/;

/** Título sem o contador `(N) ` (o que o Next define). */
export function stripUnreadPrefix(title: string): string {
  return title.replace(PREFIX, "");
}

/** `(3) Conversas · DuckChat`. Com zero, devolve o título sem contador. */
export function withUnreadPrefix(title: string, count: number): string {
  const base = stripUnreadPrefix(title);
  if (count <= 0) return base;
  return `(${count > 99 ? "99+" : count}) ${base}`;
}
