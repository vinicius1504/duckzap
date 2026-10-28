import { isIP } from "node:net";

// Allowlist de IPs do painel (ADMIN_IP_ALLOWLIST): IPv4 exato ou CIDR; IPv6 só exato. Vazia = sem restrição.

export type IpRule = { kind: "v4"; network: number; mask: number } | { kind: "v6"; address: string };

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
}

/** "::ffff:1.2.3.4" → "1.2.3.4"; minúsculas no IPv6. */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}

export function parseAllowlist(entries: string[]): IpRule[] {
  return entries.map((entry): IpRule => {
    const [address = "", bits] = entry.trim().split("/");
    const normalized = normalizeIp(address);
    if (isIP(normalized) === 4) {
      const prefix = bits === undefined ? 32 : Number(bits);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        throw new Error(`ADMIN_IP_ALLOWLIST: máscara inválida em "${entry}"`);
      }
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      return { kind: "v4", network: ((v4ToInt(normalized) ?? 0) & mask) >>> 0, mask };
    }
    if (isIP(normalized) === 6 && bits === undefined) return { kind: "v6", address: normalized };
    throw new Error(`ADMIN_IP_ALLOWLIST: entrada inválida "${entry}"`);
  });
}

export function isIpAllowed(ip: string | null, rules: IpRule[]): boolean {
  if (rules.length === 0) return true;
  if (!ip) return false;
  const normalized = normalizeIp(ip);
  if (isIP(normalized) === 4) {
    const value = v4ToInt(normalized) ?? 0;
    return rules.some((rule) => rule.kind === "v4" && ((value & rule.mask) >>> 0) === rule.network);
  }
  return rules.some((rule) => rule.kind === "v6" && rule.address === normalized);
}

/**
 * IP do cliente. Sem proxy confiável: endereço do socket (x-forwarded-for é falsificável e é IGNORADO).
 * Com ADMIN_TRUST_PROXY=true: o ÚLTIMO item de x-forwarded-for (o que o nosso proxy acrescentou).
 */
export function clientIp(input: {
  forwardedFor: string | null | undefined;
  socketAddress: string | null | undefined;
  trustProxy: boolean;
}): string | null {
  if (input.trustProxy && input.forwardedFor) {
    const last = input.forwardedFor.split(",").pop()?.trim();
    if (last) return normalizeIp(last);
  }
  return input.socketAddress ? normalizeIp(input.socketAddress) : null;
}
