import { clientIp as clientIpOf } from "../../lib/client-ip";
import { hashApiKey } from "../../lib/crypto";
import { isIP } from "node:net";
import { assertSafeUrl, assertSafeUrlShape, systemResolver, type Resolver } from "../settings/ssrf";
import { loadSecurityConfig } from "../../middleware/security-config";

/** Formato do token da URL do webhook: `dzwh_` + 32 bytes em base64url (43 caracteres). */
export const WEBHOOK_TOKEN_PATTERN = /^dzwh_[A-Za-z0-9_-]{43}$/;

/** O que vai para o banco na busca pública: o hash, nunca o token. */
export const hashWebhookToken = (token: string) => hashApiKey(token);

/**
 * Gancho de allowlist (§3.6): decide se o IP de origem pode chamar o webhook de um provedor.
 * Padrão: libera tudo (a Evolution fala por rede interna; a Meta publica faixas de IP que podem ser carregadas aqui).
 */
export type WebhookAllowlist = (input: { provider: string; ip: string | null }) => boolean;
export const allowAll: WebhookAllowlist = () => true;

/** IP do cliente conforme o proxy (Caddy) informa. Só serve para rate limit/allowlist, nunca para autenticar. */
export function clientIp(headers: Headers, options?: { trustProxy?: boolean }): string | null {
  // lógica única em lib/client-ip.ts: o ÚLTIMO item de x-forwarded-for (do nosso proxy) ou nada; nunca o primeiro (falsificável)
  return clientIpOf({ headers }, { trustProxy: options?.trustProxy ?? loadSecurityConfig().trustProxy });
}

/** Tamanho máximo do corpo de um webhook (a Meta manda alguns KB). */
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

/**
 * Anti-SSRF para `mediaUrl`: quem baixa o arquivo é o provedor (Evolution dentro da nossa rede, Meta fora).
 * Aceita só https e recusa hosts privados/loopback/metadata e IPs literais. Forma (sem rede): reaproveita
 * `assertSafeUrlShape` (que tira o ponto final do host: "localhost." e "x.internal." valem como "localhost"/"x.internal").
 * Para fechar "127.0.0.1.nip.io" (nome público que aponta para IP interno) use `isSafeMediaUrlResolved`.
 */
export function isSafeMediaUrl(value: string): boolean {
  let url: URL;
  try {
    url = assertSafeUrlShape(value);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (isIP(host) !== 0) return false; // IP literal (v4/v6): só nome de host
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return false; // formas numéricas de IPv4
  return host.includes(".");
}

/** Forma + DNS: todos os IPs que o host resolve precisam ser públicos (usa `isBlockedIp` do SSRF de webhooks de saída). */
export async function isSafeMediaUrlResolved(value: string, resolve: Resolver = systemResolver): Promise<boolean> {
  if (!isSafeMediaUrl(value)) return false;
  try {
    await assertSafeUrl(value, resolve);
    return true;
  } catch {
    return false;
  }
}
