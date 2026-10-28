/**
 * Content-Security-Policy com nonce por requisição (INSTRUCTIONS §5.3). Função pura: usada pelo `proxy.ts`.
 *
 * - Produção: `script-src 'nonce-…' 'strict-dynamic'` (nenhum script sem nonce roda; sem 'unsafe-inline' nem 'unsafe-eval').
 * - `style-src` mantém 'unsafe-inline': o Next injeta <style> e o React usa `style=""` em alguns componentes;
 *   o risco é baixo (sem script) e a alternativa (nonce em todo estilo) não é suportada pelo Next/Tailwind hoje.
 * - Desenvolvimento: modo relaxado ('unsafe-eval' para o React/HMR e websocket), senão o HMR quebra.
 */
export type CspOptions = {
  nonce: string;
  isDev?: boolean;
};

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildCsp({ nonce, isDev = false }: CspOptions): string {
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      isDev ? ["'self'", `'nonce-${nonce}'`, "'unsafe-eval'", "'unsafe-inline'"] : ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"],
    ],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", isDev ? ["'self'", "ws:", "wss:"] : ["'self'"]],
    ["base-uri", ["'none'"]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
  ];
  const parts = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  if (!isDev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}
