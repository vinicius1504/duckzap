import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// TOTP (RFC 6238, HMAC-SHA1, 6 dígitos, passo de 30 s) — o formato que todo app autenticador aceita.
// `@better-auth/utils` (que o Better Auth usa) não é dependência direta do apps/api no pnpm; só `node:crypto` aqui.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, "").toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("base32 inválido");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo de 160 bits em base32 (formato da chave manual / QR). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUri(input: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** Código HOTP de um contador (RFC 4226). */
export function hotp(secretBase32: string, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(buffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function totpCode(secretBase32: string, nowMs: number): string {
  return hotp(secretBase32, totpStep(nowMs));
}

function safeEqualText(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Confere o código numa janela de ±`window` passos (tolera relógio defasado). Compara todos os passos da janela
 * em tempo constante (sem retorno antecipado). Devolve o passo que bateu ou null. `minStep` impede reuso: só aceita
 * passos > último já usado.
 */
export function verifyTotp(input: {
  secret: string;
  code: string;
  nowMs: number;
  window?: number;
  minStep?: number | null;
}): number | null {
  if (!/^\d{6}$/.test(input.code)) return null;
  const window = input.window ?? 1;
  const current = totpStep(input.nowMs);
  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step++) {
    const hit = safeEqualText(hotp(input.secret, step), input.code);
    if (hit && (input.minStep == null || step > input.minStep) && (matched === null || step > matched)) matched = step;
  }
  return matched;
}
