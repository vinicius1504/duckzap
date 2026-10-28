/**
 * Content-Security-Policy com nonce por requisição (INSTRUCTIONS §5.3). Função pura: usada pelo `proxy.ts`.
 *
 * - Produção: `script-src 'nonce-…' 'strict-dynamic'` (nenhum script sem nonce roda; sem 'unsafe-inline' nem 'unsafe-eval').
 * - `style-src` mantém 'unsafe-inline': o Next injeta <style> e o React usa `style=""` em alguns componentes;
 *   o risco é baixo (sem script) e a alternativa (nonce em todo estilo) não é suportada pelo Next/Tailwind hoje.
 * - Desenvolvimento: modo relaxado ('unsafe-eval' para o React/HMR e websocket), senão o HMR quebra.
 * - Tempo real (WebSocket): em produção `'self'` já cobre `wss://` no mesmo host (ex.: `wss://app.exemplo.com/ws`).
 *   Se `NEXT_PUBLIC_REALTIME_URL` aponta para outro host, a origem dele entra no `connect-src`.
 * - Mídia da conversa: o navegador faz PUT direto no armazenamento (S3/R2/MinIO) e lê por URL assinada de lá. A(s) origem(ns)
 *   vêm de `MEDIA_STORAGE_PUBLIC_ENDPOINT` (lista separada por vírgula, lida a cada requisição) e entram em connect-src, img-src e media-src.
 *   Em desenvolvimento, localhost (MinIO local) já fica liberado.
 */
export type CspOptions = {
  nonce: string;
  isDev?: boolean;
  /** `NEXT_PUBLIC_REALTIME_URL`; por padrão lê da variável de ambiente (valor embutido no build). */
  realtimeUrl?: string | undefined;
  /** `MEDIA_STORAGE_PUBLIC_ENDPOINT`; por padrão lê da variável de ambiente. */
  mediaOrigins?: string | undefined;
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

/**
 * Origens http(s) do armazenamento de mídia (`https://conta.r2.cloudflarestorage.com, http://localhost:9000`).
 * Só protocolo + host: nada do texto original passa direto para o header; entradas inválidas são ignoradas.
 */
export function mediaStorageOrigins(raw: string | undefined): string[] {
  const origins = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    try {
      const url = new URL(part.trim());
      if (url.protocol === "http:" || url.protocol === "https:") origins.add(`${url.protocol}//${url.host}`);
    } catch {
      // ignora
    }
  }
  return [...origins];
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildCsp({
  nonce,
  isDev = false,
  realtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL,
  mediaOrigins = process.env.MEDIA_STORAGE_PUBLIC_ENDPOINT,
}: CspOptions): string {
  const realtime = realtimeOrigin(realtimeUrl);
  const storage = [...mediaStorageOrigins(mediaOrigins), ...(isDev ? ["http://localhost:*", "http://127.0.0.1:*"] : [])];
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      isDev ? ["'self'", `'nonce-${nonce}'`, "'unsafe-eval'", "'unsafe-inline'"] : ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"],
    ],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https:", ...storage]],
    ["media-src", ["'self'", "blob:", ...storage]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'", ...(isDev ? ["ws:", "wss:"] : realtime ? [realtime] : []), ...storage]],
    ["base-uri", ["'none'"]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
  ];
  const parts = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  if (!isDev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}
