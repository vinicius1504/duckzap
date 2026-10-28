import { describe, expect, it } from "vitest";
import { hashApiKey } from "../../lib/crypto";
import { extractApiKey, newApiKeySecret, organizationIdFromApiKey } from "./api-keys";

describe("chaves de API (formato e extração)", () => {
  it("o segredo leva o prefixo e a empresa, e dá para recuperar a empresa", () => {
    const secret = newApiKeySecret("0192f0aa-1111-7222-8333-444455556666");
    expect(secret.startsWith("dz_live_0192f0aa-1111-7222-8333-444455556666.")).toBe(true);
    expect(organizationIdFromApiKey(secret)).toBe("0192f0aa-1111-7222-8333-444455556666");
    expect(secret.length).toBeGreaterThan(60);
  });

  it("empresas com underscore no id também funcionam (o ponto separa)", () => {
    expect(organizationIdFromApiKey(newApiKeySecret("org_alvorada"))).toBe("org_alvorada");
  });

  it("segredos diferentes a cada geração; só o hash é determinístico", () => {
    const a = newApiKeySecret("org_a");
    const b = newApiKeySecret("org_a");
    expect(a).not.toBe(b);
    expect(hashApiKey(a)).toBe(hashApiKey(a));
    expect(hashApiKey(a)).not.toBe(hashApiKey(b));
    expect(hashApiKey(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("formato inválido não devolve empresa", () => {
    expect(organizationIdFromApiKey("sk_live_abc.def")).toBeNull();
    expect(organizationIdFromApiKey("dz_live_semponto")).toBeNull();
    expect(organizationIdFromApiKey("dz_live_.abc")).toBeNull();
    expect(organizationIdFromApiKey("dz_live_abc.")).toBeNull();
  });

  it("lê Authorization Bearer ou X-API-Key", () => {
    expect(extractApiKey(new Headers({ authorization: "Bearer dz_live_x.y" }))).toBe("dz_live_x.y");
    expect(extractApiKey(new Headers({ "x-api-key": "dz_live_x.y" }))).toBe("dz_live_x.y");
    expect(extractApiKey(new Headers())).toBeNull();
  });
});
