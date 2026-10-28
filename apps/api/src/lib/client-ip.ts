import { isIP } from "node:net";

/**
 * IP do cliente, num lugar só (login, aceite de convite, webhooks, painel).
 *
 * - Sem proxy confiável (`trustProxy: false`): vale só o endereço do socket. `x-forwarded-for` é escrito pelo
 *   cliente e é IGNORADO (senão qualquer um troca de "IP" a cada tentativa e foge do limite de tentativas).
 * - Atrás de proxy confiável (`trustProxy: true`, ex.: Caddy): vale o ÚLTIMO item de `x-forwarded-for`, o que o
 *   nosso proxy acrescentou; os itens anteriores vieram do cliente e não são confiáveis. Sem o cabeçalho, volta ao socket.
 *
 * Só serve para limite de tentativas, allowlist e log. Nunca para autenticar.
 */
export function clientIp(
  source: { headers: Headers },
  options: { trustProxy: boolean; socketAddress?: string | null | undefined },
): string | null {
  if (options.trustProxy) {
    const last = source.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
    const normalized = last ? normalizeIp(last) : null;
    if (normalized) return normalized;
  }
  return options.socketAddress ? normalizeIp(options.socketAddress) : null;
}

/** "::ffff:1.2.3.4" → "1.2.3.4"; minúsculas; devolve null se não for um IP válido. */
export function normalizeIp(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(trimmed);
  const candidate = mapped?.[1] ?? trimmed;
  return isIP(candidate) ? candidate : null;
}

/** Endereço do socket no servidor Node do Hono (`c.env.incoming`); null em teste ou outros runtimes. */
export function socketAddressOf(env: unknown): string | null {
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? null;
}
