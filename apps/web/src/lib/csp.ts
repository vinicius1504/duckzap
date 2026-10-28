/**
 * Content-Security-Policy com nonce por requisição (INSTRUCTIONS §5.3). Função pura: usada pelo `proxy.ts`.
 *
 * - Produção: `script-src 'nonce-…' 'strict-dynamic'` (nenhum script sem nonce roda; sem 'unsafe-inline' nem 'unsafe-eval').
 * - `style-src` mantém 'unsafe-inline': o Next injeta <style> e o React usa `style=""` em alguns componentes;
 *   o risco é baixo (sem script) e a alternativa (nonce em todo estilo) não é suportada pelo Next/Tailwind hoje.
 * - Desenvolvimento: modo relaxado ('unsafe-eval' para o React/HMR e websocket), senão o HMR quebra.
 * - Tempo real (WebSocket): em produção `'self'` já cobre `wss://` no mesmo host (ex.: `wss://app.exemplo.com/ws`).
 *   Se `NEXT_PUBLIC_REALTIME_URL` aponta para outro host, a origem dele entra no `connect-src`.
 */
export type CspOptions = {
  nonce: string;
  isDev?: boolean;
  /** `NEXT_PUBLIC_REALTIME_URL`; por padrão lê da variável de ambiente (valor embutido no build). */
  realtimeUrl?: string | undefined;
};

/**
 * Origem (`wss://host:porta`) do endereço de tempo real, para o `connect-src`. Só ws/wss; qualquer outra coisa
 * (vazio, relativo, http, lixo) vira `null`. Remonta a partir de protocolo + host: nada do texto original passa direto para o header.
 */
export function realtimeOrigin(realtimeUrl: string | undefined): string | null {
  const raw = realtimeUrl?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildCsp({ nonce, isDev = false, realtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL }: CspOptions): string {
  const realtime = realtimeOrigin(realtimeUrl);
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      isDev ? ["'self'", `'nonce-${nonce}'`, "'unsafe-eval'", "'unsafe-inline'"] : ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"],
    ],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", isDev ? ["'self'", "ws:", "wss:"] : realtime ? ["'self'", realtime] : ["'self'"]],
    ["base-uri", ["'none'"]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
  ];
  const parts = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  if (!isDev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}
