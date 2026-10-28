import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, loadMasterKeys } from "./crypto";

const key = () => randomBytes(32).toString("base64");
const saved = { single: process.env.ENCRYPTION_KEY, list: process.env.ENCRYPTION_KEYS };

beforeEach(() => {
  delete process.env.ENCRYPTION_KEYS;
  process.env.ENCRYPTION_KEY = key();
});
afterEach(() => {
  if (saved.single === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = saved.single;
  if (saved.list === undefined) delete process.env.ENCRYPTION_KEYS;
  else process.env.ENCRYPTION_KEYS = saved.list;
});

/** Reproduz o formato v1 antigo para provar que ainda é decifrado. */
async function legacyV1(orgId: string, text: string) {
  const { createCipheriv, hkdfSync } = await import("node:crypto");
  const master = Buffer.from(process.env.ENCRYPTION_KEY as string, "base64");
  const k = Buffer.from(hkdfSync("sha256", master, Buffer.from(orgId), Buffer.from("duckzap-secrets-v1"), 32));
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
}

describe("crypto de segredos", () => {
  it("round-trip v2 com ENCRYPTION_KEY sozinha", () => {
    const enc = encryptSecret("org_a", "segredo");
    expect(enc.startsWith("v2:default:")).toBe(true);
    expect(decryptSecret("org_a", enc)).toBe("segredo");
  });

  it("decifra o formato v1 legado", async () => {
    expect(decryptSecret("org_a", await legacyV1("org_a", "antigo"))).toBe("antigo");
  });

  it("outra empresa ou outro contexto não decifra (AAD)", () => {
    const enc = encryptSecret("org_a", "x", "channel.credentials");
    expect(decryptSecret("org_a", enc, "channel.credentials")).toBe("x");
    expect(() => decryptSecret("org_a", enc, "outra.coluna")).toThrow();
    expect(() => decryptSecret("org_a", enc)).toThrow();
    expect(() => decryptSecret("org_b", enc, "channel.credentials")).toThrow();
  });

  it("detecta adulteração", () => {
    const enc = encryptSecret("org_a", "texto longo o bastante");
    const parts = enc.split(":");
    parts[4] = Buffer.from("adulterado-adulterado").toString("base64url");
    expect(() => decryptSecret("org_a", parts.join(":"))).toThrow();
    expect(() => decryptSecret("org_a", "lixo")).toThrow(/formato inválido/);
  });

  it("chave errada falha", () => {
    const enc = encryptSecret("org_a", "x");
    process.env.ENCRYPTION_KEY = key();
    expect(() => decryptSecret("org_a", enc)).toThrow();
  });

  it("rotação: a primeira de ENCRYPTION_KEYS cifra, as antigas ainda decifram", () => {
    const old = process.env.ENCRYPTION_KEY as string;
    const before = encryptSecret("org_a", "antes");
    const next = key();
    process.env.ENCRYPTION_KEYS = `k2:${next},default:${old}`;
    const after = encryptSecret("org_a", "depois");
    expect(after.startsWith("v2:k2:")).toBe(true);
    expect(decryptSecret("org_a", after)).toBe("depois");
    expect(decryptSecret("org_a", before)).toBe("antes");
    // sem a chave antiga na lista, o valor antigo não abre
    process.env.ENCRYPTION_KEYS = `k2:${next}`;
    delete process.env.ENCRYPTION_KEY;
    expect(() => decryptSecret("org_a", before)).toThrow(/não está configurada/);
  });

  it("valida a configuração", () => {
    expect(() => loadMasterKeys({} as NodeJS.ProcessEnv)).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadMasterKeys({ ENCRYPTION_KEY: "curta" } as NodeJS.ProcessEnv)).toThrow(/32 bytes/);
    expect(() => loadMasterKeys({ ENCRYPTION_KEYS: "sem-dois-pontos" } as NodeJS.ProcessEnv)).toThrow(/formato/);
    expect(loadMasterKeys({ ENCRYPTION_KEY: key() } as NodeJS.ProcessEnv).active.kid).toBe("default");
  });
});
