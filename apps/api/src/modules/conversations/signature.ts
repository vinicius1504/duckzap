/**
 * Assinatura das mensagens de PESSOA no WhatsApp do cliente: `*Rafael (Vendas):*` numa linha e o texto na de baixo.
 * O que fica gravado no sistema é só o que a pessoa digitou; a assinatura é aplicada na hora de enviar ao provedor.
 */

const MAX_TEAM_CHARS = 30;

/** Tira o que quebraria a formatação do WhatsApp (`*negrito*`, `_itálico_`, `~riscado~`, crase) e quebras de linha. */
function plain(value: string): string {
  return value.replace(/[*_~`\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

export function signatureLabel(memberName: string, teamName: string | null): string | null {
  const first = plain(memberName).split(" ")[0] ?? "";
  if (!first) return null;
  const team = teamName ? plain(teamName).slice(0, MAX_TEAM_CHARS).trim() : "";
  return team ? `${first} (${team})` : first;
}

/** Texto como o cliente recebe. Sem nome utilizável ou sem texto, devolve o original. */
export function signMessage(body: string, memberName: string, teamName: string | null): string {
  if (!body.trim()) return body;
  const label = signatureLabel(memberName, teamName);
  return label ? `*${label}:*\n${body}` : body;
}
