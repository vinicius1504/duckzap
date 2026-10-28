import { RULES_MARKER } from "./prompt";
import { extractMonetaryClaims, maskPii } from "./text";

/**
 * Guardrails de SAÍDA (§4.3). Rodam sobre o que o modelo quer enviar, antes de qualquer envio.
 * Qualquer violação bloqueia a resposta (o pipeline então faz handoff); nunca "conserta" conteúdo factual.
 */

export const MAX_MESSAGE_CHARS = 900;

export type GuardrailCode =
  | "empty"
  | "too_long"
  | "invented_price"
  | "third_party_data"
  | "url_not_allowed"
  | "prompt_leak"
  | "message_limit";

export type GuardrailInput = {
  text: string;
  /** Conhecimento do agente + trechos recuperados + mensagens anteriores do próprio agente (vale para preços e contatos). */
  knowledgeCorpus: string;
  /**
   * Texto em que os LINKS podem ser confiados: só o que a empresa escreveu (conhecimento estático, prompt do agente,
   * mensagens anteriores do agente). Trechos recuperados de documentos NÃO entram (documento envenenado). Se omitido,
   * usa `knowledgeCorpus` (compatibilidade).
   */
  linkCorpus?: string;
  /** Domínios permitidos (allowlist da empresa). Hosts citados no conhecimento também valem. */
  urlAllowlist: string[];
  /** Telefones/e-mails que podem aparecer (do próprio cliente). */
  ownContactValues: string[];
  systemPrompt: string;
  /** Só as regras internas (`buildRulesBlock`). Se omitido, extraídas de `systemPrompt` a partir de RULES_MARKER. */
  internalRules?: string;
  nonce: string;
  maxConsecutiveMessages: number;
  alreadySent: number;
  maxChars?: number;
};

export type GuardrailResult = { ok: true; messages: string[] } | { ok: false; code: GuardrailCode; reason: string };

const digits = (s: string) => s.replace(/\D/g, "");

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** Sequências de 10 a 13 dígitos com separadores livres (espaço, ponto, hífen, parênteses). */
const PHONE_RUN = /\+?\d(?:[\s().-]{0,2}\d){9,12}(?!\d)/g;
function phoneSequences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PHONE_RUN)) {
    const d = digits(m[0]);
    if (d.length >= 10 && d.length <= 13) out.push(d);
  }
  return out;
}
const CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/;
const CNPJ = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
// Qualquer "rótulo.rótulo" com TLD alfabético conta como host (sem lista de TLDs): "evil.zip", "evil.ru".
const URL_LIKE = /(?<![\w@.-])(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24}))(?![\w-])(?::\d+)?(?:\/[^\s]*)?/gi;
const EXPLICIT_URL = /\bhttps?:\/\/([a-z0-9.-]+)(?::\d+)?(?:\/[^\s]*)?/gi;
const FILE_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "gif", "doc", "docx", "xls", "xlsx", "txt", "csv", "mp3", "mp4", "ppt", "pptx"]);
const SPELLED_TLDS = "com|br|net|org|io|app|me|ly|co|dev|site|online|shop|store|link|gl|xyz|info|biz|ru|cn|tk|top|club|zip|mov";
// "evil dot com", "evil ponto com", "evil[.]com"
const SPELLED_DOT = new RegExp(String.raw`([a-z0-9-]+)\s*(?:\(\s*\.\s*\)|\[\s*\.\s*\]|\s+(?:dot|ponto)\s+)\s*(${SPELLED_TLDS})\b`, "gi");

export function extractHosts(text: string) {
  const noEmail = text.replace(EMAIL, " ");
  const hosts = new Set<string>();
  for (const m of noEmail.matchAll(URL_LIKE)) {
    const host = m[1]?.toLowerCase();
    const tld = m[2] ?? "";
    if (!host) continue;
    const explicit = /^(?:https?:\/\/|www\.)/i.test(m[0]);
    // "fim.Obrigado" (frase sem espaço depois do ponto) e nomes de arquivo comuns não são links
    if (!explicit && (/^[A-Z][a-z]+$/.test(tld) || FILE_EXTENSIONS.has(tld.toLowerCase()))) continue;
    hosts.add(host.replace(/\.$/, ""));
  }
  for (const m of noEmail.matchAll(EXPLICIT_URL)) if (m[1]) hosts.add(m[1].toLowerCase().replace(/\.$/, ""));
  for (const m of noEmail.matchAll(SPELLED_DOT)) if (m[1] && m[2]) hosts.add(`${m[1]}.${m[2]}`.toLowerCase());
  return [...hosts];
}

function hostAllowed(host: string, allowed: string[]) {
  return allowed.some((a) => {
    const d = a.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    const h = host.replace(/^www\./, "");
    return h === d || h.endsWith(`.${d}`);
  });
}

export function splitMessages(text: string, maxChars: number): string[] | null {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const out: string[] = [];
  let current = "";
  for (const para of clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length > maxChars) return null;
    if (current && current.length + para.length + 2 > maxChars) {
      out.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Só as regras internas do system prompt (do "REGRAS INVIOLÁVEIS" até o bloco `<conhecimento>`). A persona (descrição,
 * tom, resumo da empresa, instruções) e o conhecimento são conteúdo do NEGÓCIO e a resposta pode citá-los
 * (horário, oferta, endereço); tratá-los como "instrução interna" bloqueava respostas legítimas.
 */
function internalRulesOf(systemPrompt: string) {
  const start = systemPrompt.indexOf(RULES_MARKER);
  if (start < 0) return "";
  const knowledgeAt = systemPrompt.indexOf("\n<conhecimento>", start);
  return systemPrompt.slice(start, knowledgeAt < 0 ? undefined : knowledgeAt);
}

function leaksPrompt(text: string, internalRules: string, nonce: string) {
  if (text.includes(nonce) || text.includes(RULES_MARKER)) return true;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
  const out = norm(text);
  // qualquer linha longa das regras internas reproduzida na resposta
  return internalRules
    .split("\n")
    .map((l) => norm(l.trim()))
    .filter((l) => l.length >= 45)
    .some((l) => out.includes(l.slice(0, 60)));
}

export function checkOutput(input: GuardrailInput): GuardrailResult {
  const text = input.text.trim();
  if (!text) return { ok: false, code: "empty", reason: "Resposta vazia." };

  if (leaksPrompt(text, input.internalRules ?? internalRulesOf(input.systemPrompt), input.nonce)) {
    return { ok: false, code: "prompt_leak", reason: "A resposta reproduz instruções internas." };
  }

  // preços, descontos, percentuais e parcelas: só o que existir no conhecimento
  const knownClaims = extractMonetaryClaims(input.knowledgeCorpus);
  const known = (kind: string, value: number) => knownClaims.some((c) => c.kind === kind && c.value === value);
  const unknownClaim = extractMonetaryClaims(text).find((c) => !known(c.kind, c.value));
  if (unknownClaim) {
    return { ok: false, code: "invented_price", reason: "A resposta cita um valor, desconto ou parcela que não está no conhecimento." };
  }

  // dados de terceiros / sensíveis
  if (CPF.test(text) || CNPJ.test(text) || [...text.matchAll(CARD)].some((m) => maskPii(m[0]) !== m[0])) {
    return { ok: false, code: "third_party_data", reason: "A resposta contém documento ou cartão." };
  }
  const allowedEmails = new Set([...input.ownContactValues, input.knowledgeCorpus].flatMap((v) => v.match(EMAIL) ?? []).map((e) => e.toLowerCase()));
  for (const m of text.matchAll(EMAIL)) {
    if (!allowedEmails.has(m[0].toLowerCase())) return { ok: false, code: "third_party_data", reason: "A resposta cita um e-mail que não é do cliente nem da empresa." };
  }
  // telefones: normaliza para dígitos (separadores livres: "11 98765.4321", "11 9 8765 4321") antes de comparar
  // números colados por separador ("(11) 3333-4444 10% ...") formam uma sequência só: comparamos todas as janelas
  const allowedTails = new Set<string>();
  const addWindows = (d: string) => {
    for (let i = 0; i + 8 <= d.length; i++) allowedTails.add(d.slice(i, i + 8));
  };
  for (const v of input.ownContactValues) addWindows(digits(v));
  for (const d of phoneSequences(input.knowledgeCorpus.replace(EMAIL, " "))) addWindows(d);
  for (const d of phoneSequences(text.replace(EMAIL, " "))) {
    let allowed = false;
    for (let end = 10; end <= d.length && !allowed; end++) allowed = allowedTails.has(d.slice(end - 8, end));
    if (!allowed) {
      return { ok: false, code: "third_party_data", reason: "A resposta cita um telefone que não é do cliente nem da empresa." };
    }
  }

  // URLs: só da allowlist da empresa ou do texto que a empresa escreveu (nunca de trechos de documentos recuperados)
  const allowedHosts = [...input.urlAllowlist, ...extractHosts(input.linkCorpus ?? input.knowledgeCorpus)];
  const badHost = extractHosts(text).find((h) => !hostAllowed(h, allowedHosts));
  if (badHost) return { ok: false, code: "url_not_allowed", reason: `Link fora da lista permitida: ${badHost}.` };

  // tamanho e limite de mensagens seguidas
  const parts = splitMessages(text, input.maxChars ?? MAX_MESSAGE_CHARS);
  if (!parts) return { ok: false, code: "too_long", reason: "Parágrafo maior que o limite de uma mensagem." };
  if (input.alreadySent + parts.length > input.maxConsecutiveMessages) {
    return { ok: false, code: "message_limit", reason: "Limite de mensagens seguidas sem resposta do cliente." };
  }
  return { ok: true, messages: parts };
}
