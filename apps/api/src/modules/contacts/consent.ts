import type { ConsentStatus } from "@duckzap/contracts/contacts";

// Regras puras do consentimento de disparo (INSTRUCTIONS §5.7 item 7). Palavras-chave primeiro; na dúvida,
// NÃO conta como aceito (a IA só entra em casos ambíguos, em outro ponto do sistema).

export const CONSENT_INVITE_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

export type ReplyIntent = "granted" | "denied" | "ambiguous";

function tokens(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// recusa e saída (inclui "n"/"nao"); "para" sozinho conta, mas "para" no meio de frase não
const NEGATIVE = new Set([
  "nao", "n", "sair", "sai", "saia", "parar", "pare", "cancelar", "cancela", "cancele", "remover", "remova",
  "descadastrar", "descadastra", "stop", "chega", "nunca", "bloquear", "bloqueia", "denuncia", "denunciar", "spam",
]);
const POSITIVE = new Set([
  "sim", "s", "ss", "simm", "aceito", "aceita", "aceitamos", "pode", "podem", "claro", "ok", "okay", "quero",
  "autorizo", "topo", "beleza", "blz", "confirmo", "yes", "uhum",
]);
// palavras que acompanham um "sim" sem mudar o sentido
const FILLER = new Set([
  "com", "certeza", "por", "favor", "pfv", "pf", "obrigado", "obrigada", "obg", "valeu", "ja", "e", "eu", "o", "a",
  "de", "mande", "manda", "mandar", "enviar", "envie", "enviem", "receber", "la", "tudo", "bem", "sempre",
]);

/** Interpreta a resposta ao convite. Qualquer recusa vence; "sim" só vale em resposta curta e sem outro assunto. */
export function interpretConsentReply(text: string): ReplyIntent {
  if (/^\s*(?:\u{1F44D}|\u2705)[\s\u{1F3FB}-\u{1F3FF}]*$/u.test(text)) return "granted";
  const words = tokens(text);
  if (words.length === 0) return "ambiguous";
  if (words.some((w) => NEGATIVE.has(w)) || (words.length === 1 && words[0] === "para")) return "denied";
  if (words.some((w) => w === "sem") && words.includes("interesse")) return "denied";
  const allKnown = words.every((w) => POSITIVE.has(w) || FILLER.has(w));
  if (words.length <= 6 && allKnown && words.some((w) => POSITIVE.has(w))) return "granted";
  return "ambiguous";
}

/** Saída explícita numa conversa comum (campanha, atendimento): mais estrita que a resposta ao convite. */
export function isExplicitOptOut(text: string): boolean {
  const words = tokens(text);
  if (words.length === 0 || words.length > 5) return false;
  const exit = ["sair", "parar", "pare", "cancelar", "descadastrar", "stop", "remover", "remova"];
  return words.some((w) => exit.includes(w));
}

type ConsentLike = { status: string; inviteSentAt: Date | null };

/** `pending` com convite enviado há mais de 7 dias vale como `expired`, mesmo antes do job de expiração. */
export function effectiveConsentStatus(consent: ConsentLike, now: Date): ConsentStatus {
  const status = consent.status as ConsentStatus;
  if (status === "pending" && consent.inviteSentAt && now.getTime() - consent.inviteSentAt.getTime() > CONSENT_INVITE_TTL_DAYS * DAY_MS) {
    return "expired";
  }
  return status;
}

export function inviteCutoff(now: Date) {
  return new Date(now.getTime() - CONSENT_INVITE_TTL_DAYS * DAY_MS);
}

/**
 * Transição do consentimento diante de uma resposta. `denied` é permanente (nada o reverte); recusa vence
 * até um `granted` anterior; resposta ambígua não muda nada.
 */
export function nextConsentStatus(current: ConsentStatus, reply: ReplyIntent): ConsentStatus {
  if (current === "denied") return "denied";
  if (reply === "denied") return "denied";
  if (reply === "granted") return "granted";
  return current;
}
