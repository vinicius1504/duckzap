import { createHmac } from "node:crypto";
import { safeEqual } from "../../lib/crypto";

/**
 * Assinatura dos webhooks de saída: header `X-Duckzap-Signature: t=<unix>,v1=<hex>`, onde
 * v1 = HMAC-SHA256(segredo, `${t}.${corpo}`). Quem recebe recalcula e compara; o `t` permite recusar repetição antiga.
 */
export const SIGNATURE_HEADER = "X-Duckzap-Signature";

export function signWebhookBody(secret: string, body: string, timestamp: number = Math.floor(Date.now() / 1000)) {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifyWebhookSignature(secret: string, body: string, header: string, toleranceSeconds = 300, now = Date.now()) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  const expected = signWebhookBody(secret, body, t).split("v1=")[1] ?? "";
  return safeEqual(expected, v1);
}
