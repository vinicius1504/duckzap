import { createHmac, timingSafeEqual } from "node:crypto";
import type { ConnectionStatus } from "../../../lib/messaging";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Só dígitos → E.164 com "+". Devolve undefined se não parece um telefone. */
export function toE164(value: string | undefined | null): string | undefined {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
}

/** Destino enviado ao provedor: só dígitos (sem "+"). */
export function toDigits(value: string) {
  return value.replace(/\D/g, "");
}

export function isoFromSeconds(value: unknown, fallback: Date = new Date()): string {
  const seconds = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback.toISOString();
  return new Date(seconds * 1000).toISOString();
}

export function hmacSha256Hex(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Comparação em tempo constante de strings de qualquer tamanho. */
export function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function readBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type Inspect = { status: ConnectionStatus; address?: string };
