import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Cifra de segredos de integração em repouso (§5.2): AES-256-GCM com chave derivada por empresa
 * (HKDF da chave mestra + id da empresa). Em produção a chave mestra vem de um KMS; aqui, de variáveis de ambiente.
 *
 * Formatos (base64url):
 *  - `v2:<kid>:<iv>:<tag>:<texto>`: gravação atual. `<kid>` identifica a chave mestra usada (rotação), e o
 *    AAD amarra o texto à empresa e ao uso (`context`, ex.: "channel.credentials"): copiar o valor para outra coluna falha.
 *  - `v1:<iv>:<tag>:<texto>`: legado (sem kid e sem AAD). Continua sendo decifrado com `ENCRYPTION_KEY`.
 *
 * Chaves: `ENCRYPTION_KEYS="kid1:<base64>,kid2:<base64>"` (a PRIMEIRA cifra; as demais só decifram, para rotação).
 * `ENCRYPTION_KEY` (32 bytes em base64) continua valendo sozinha (kid "default") e é a chave dos valores `v1`.
 */

const KID = /^[A-Za-z0-9_-]{1,32}$/;
const LEGACY_KID = "default";

type MasterKey = { kid: string; key: Buffer };

function decodeKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new Error(`${label} precisa ter 32 bytes em base64 (openssl rand -base64 32).`);
  return key;
}

/** Lê as chaves mestras do ambiente: a ativa primeiro. Lança com mensagem clara se ausentes/inválidas. */
export function loadMasterKeys(source: NodeJS.ProcessEnv = process.env): { active: MasterKey; all: MasterKey[]; legacy: Buffer | null } {
  const keys: MasterKey[] = [];
  const list = source.ENCRYPTION_KEYS?.trim();
  if (list) {
    for (const entry of list.split(",").map((part) => part.trim()).filter(Boolean)) {
      const at = entry.indexOf(":");
      const kid = at > 0 ? entry.slice(0, at) : "";
      if (!KID.test(kid)) throw new Error('ENCRYPTION_KEYS precisa estar no formato "kid:base64,kid2:base64" (kid com letras, números, _ ou -).');
      if (keys.some((k) => k.kid === kid)) throw new Error(`ENCRYPTION_KEYS repete o kid "${kid}".`);
      keys.push({ kid, key: decodeKey(entry.slice(at + 1), `A chave "${kid}" de ENCRYPTION_KEYS`) });
    }
  }
  const single = source.ENCRYPTION_KEY?.trim();
  const legacy = single ? decodeKey(single, "ENCRYPTION_KEY") : null;
  if (legacy && !keys.some((k) => k.kid === LEGACY_KID) && !keys.some((k) => k.key.equals(legacy))) keys.push({ kid: LEGACY_KID, key: legacy });
  const active = keys[0];
  if (!active) throw new Error("Defina ENCRYPTION_KEY (32 bytes em base64) ou ENCRYPTION_KEYS.");
  return { active, all: keys, legacy };
}

function tenantKey(master: Buffer, organizationId: string, version: "v1" | "v2") {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from(organizationId), Buffer.from(`duckzap-secrets-${version}`), 32));
}

function aad(organizationId: string, context: string | undefined) {
  return Buffer.from(`${organizationId}\u0000${context ?? ""}`);
}

export function encryptSecret(organizationId: string, plaintext: string, context?: string): string {
  const { active } = loadMasterKeys();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tenantKey(active.key, organizationId, "v2"), iv);
  cipher.setAAD(aad(organizationId, context));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v2", active.kid, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
}

function open(key: Buffer, iv: string, tag: string, data: string, additional: Buffer | null) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  if (additional) decipher.setAAD(additional);
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export function decryptSecret(organizationId: string, payload: string, context?: string): string {
  const parts = payload.split(":");
  const keys = loadMasterKeys();
  if (parts[0] === "v2" && parts.length === 5) {
    const [, kid, iv, tag, data] = parts as [string, string, string, string, string];
    const master = keys.all.find((k) => k.kid === kid);
    if (!master) throw new Error(`Chave de cifra "${kid}" não está configurada (ENCRYPTION_KEYS).`);
    return open(tenantKey(master.key, organizationId, "v2"), iv, tag, data, aad(organizationId, context));
  }
  if (parts[0] === "v1" && parts.length === 4) {
    const [, iv, tag, data] = parts as [string, string, string, string];
    // v1 não guarda o kid: tenta a chave legada e, na falta dela, as demais (rotação sem ENCRYPTION_KEY)
    const candidates = keys.legacy ? [keys.legacy] : keys.all.map((k) => k.key);
    let last: unknown;
    for (const master of candidates) {
      try {
        return open(tenantKey(master, organizationId, "v1"), iv, tag, data, null);
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error("Não foi possível decifrar o segredo.");
  }
  throw new Error("Segredo cifrado em formato inválido.");
}

/** Mostrar só o final de um segredo na UI (§5.2). */
export function lastFour(secret: string) {
  return secret.slice(-4);
}

/** Hash para chaves de API de clientes: só o hash fica no banco; o segredo aparece uma vez. */
export function hashApiKey(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Gera segredo com prefixo visível, ex.: `dz_live_` + 32 bytes aleatórios. */
export function generateSecret(prefix: string) {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}
