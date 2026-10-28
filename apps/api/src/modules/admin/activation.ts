import { createHmac, timingSafeEqual } from "node:crypto";
import { loadMasterKeys } from "../../lib/crypto";

/**
 * Código de ativação do 1º acesso do painel (M4). Sem ele, quem descobre a senha de um admin que ainda não cadastrou o
 * 2FA registraria o PRÓPRIO app autenticador e entraria. O código é gerado fora do painel (`scripts/admin-activation-code.ts`,
 * rodado por quem tem acesso ao servidor), impresso uma vez no terminal e entregue ao admin por outro canal.
 *
 * Sem coluna nova: o código é um HMAC do id do admin com a chave mestra (`ENCRYPTION_KEY`/`ENCRYPTION_KEYS`). Ele só vale
 * enquanto o admin não tem 2FA cadastrado (depois do enrollment a checagem deixa de existir, ou seja, uso único na prática)
 * e sai do ar se a chave mestra ativa for trocada (gere outro).
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function activationCodeFor(adminId: string, key: Buffer = loadMasterKeys().active.key): string {
  const digest = createHmac("sha256", key).update(`duckzap:admin-activation:v1:${adminId}`).digest();
  let raw = "";
  for (let i = 0; i < 20; i++) raw += ALPHABET[(digest[i] ?? 0) % ALPHABET.length];
  return raw.match(/.{5}/g)!.join("-");
}

const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function verifyActivationCode(adminId: string, given: string | undefined, key?: Buffer): boolean {
  if (!given) return false;
  const expected = Buffer.from(normalize(activationCodeFor(adminId, key)));
  const actual = Buffer.from(normalize(given).slice(0, 64));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** `ADMIN_REQUIRE_ACTIVATION_CODE`: padrão `true` em produção e `false` em dev/test (o seed de desenvolvimento continua simples). */
export function activationRequired(source: NodeJS.ProcessEnv = process.env): boolean {
  const value = source.ADMIN_REQUIRE_ACTIVATION_CODE;
  if (value === "true") return true;
  if (value === "false") return false;
  return source.NODE_ENV === "production";
}
