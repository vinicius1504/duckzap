import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Token de aceite do convite: `<id do convite>.<assinatura>`.
 *
 * O id do convite aparece na tela de Equipe (quem convida o vê); o token de aceite NÃO pode ser só o id, senão um
 * Administrador aceitaria o convite que ele mesmo criou e abriria a conta de outra pessoa. A assinatura é um HMAC-SHA256
 * do id com o `BETTER_AUTH_SECRET` (só o servidor calcula), então só quem recebeu o e-mail tem o link válido.
 * Sem coluna nova: a assinatura é derivada, não guardada. Expiração, cancelamento e uso único continuam no registro do convite.
 * (Trocar o BETTER_AUTH_SECRET invalida os convites em aberto: peça para reenviar.)
 */
const PURPOSE = "duckzap:invite-accept:v1";

function sign(secret: string, invitationId: string): string {
  return createHmac("sha256", secret).update(`${PURPOSE}:${invitationId}`).digest("base64url");
}

export function makeInviteToken(secret: string, invitationId: string): string {
  return `${invitationId}.${sign(secret, invitationId)}`;
}

/** Devolve o id do convite se (e só se) a assinatura confere; qualquer outra entrada, inclusive o id puro, dá null. */
export function parseInviteToken(secret: string, token: string): string | null {
  if (token.length > 200) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, id));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return id;
}
