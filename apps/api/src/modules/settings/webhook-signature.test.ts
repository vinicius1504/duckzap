import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhookBody, verifyWebhookSignature } from "./webhook-signature";

describe("assinatura HMAC-SHA256 dos webhooks", () => {
  const secret = "whsec_teste";
  const body = JSON.stringify({ type: "ping" });

  it("assina `t.corpo` com HMAC-SHA256 em hexadecimal", () => {
    const header = signWebhookBody(secret, body, 1_700_000_000);
    const expected = createHmac("sha256", secret).update(`1700000000.${body}`).digest("hex");
    expect(header).toBe(`t=1700000000,v1=${expected}`);
  });

  it("verifica assinatura válida e recusa corpo ou segredo adulterado", () => {
    const now = 1_700_000_100_000;
    const header = signWebhookBody(secret, body, 1_700_000_000);
    expect(verifyWebhookSignature(secret, body, header, 300, now)).toBe(true);
    expect(verifyWebhookSignature(secret, body + " ", header, 300, now)).toBe(false);
    expect(verifyWebhookSignature("outro", body, header, 300, now)).toBe(false);
  });

  it("recusa assinatura antiga (repetição)", () => {
    const header = signWebhookBody(secret, body, 1_700_000_000);
    expect(verifyWebhookSignature(secret, body, header, 300, 1_700_001_000_000)).toBe(false);
  });

  it("recusa cabeçalho malformado", () => {
    expect(verifyWebhookSignature(secret, body, "lixo")).toBe(false);
  });
});
