import type { BusinessHours } from "./types";

/** minúsculas, sem acentos, espaços normalizados */
export function normalize(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- PII (§4.3): menos dado ao LLM e logs mascarados ----------

const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

function luhn(digits: string) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Remove CPF, CNPJ e número de cartão antes de mandar ao LLM ou gravar log. */
export function maskPii(text: string) {
  return text
    .replace(CNPJ, "[CNPJ removido]")
    .replace(CARD, (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 13 && luhn(digits) ? "[cartão removido]" : m;
    })
    .replace(CPF, "[CPF removido]");
}

/** Para log: além do acima, mascara e-mail e telefone. */
export function maskForLog(text: string) {
  return maskPii(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[e-mail]")
    .replace(/(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g, "[telefone]");
}

// ---------- anti prompt injection ----------

const DELIMITER_LIKE = /<\/?\s*[\w-]*(?:dados|instru|sistema|system|conhecimento|resultado|regras|cliente)[\w-]*[^>]*>/gi;

/** Neutraliza tentativas de fechar/abrir o bloco de dados ou imitar tags do sistema. */
export function neutralizeDelimiters(text: string, nonce?: string) {
  let out = text.replace(DELIMITER_LIKE, "[tag removida]");
  if (nonce) out = out.split(nonce).join("[removido]");
  return out;
}

const INJECTION =
  /(ignor[ae]\w* (todas? )?(as |a )?(instrucoes|regras|ordens)|desconsider\w+ (as |todas )?(instrucoes|regras)|esquec\w+ (as |todas )?(instrucoes|regras)|revel\w+ (o |seu )?(prompt|system|instrucoes)|mostr\w+ (o |seu )?(prompt|system prompt)|voce agora e|a partir de agora voce|modo (desenvolvedor|dev|admin)|system prompt|you are now|ignore (all |previous )?instructions|novas instrucoes)/;

export function looksLikeInjection(text: string) {
  return INJECTION.test(normalize(text));
}

// ---------- preços ----------

/** Valores em centavos citados como "R$ 1.200,50", "R$600" ou "600 reais". */
export function extractPricesCents(text: string): number[] {
  const out: number[] = [];
  const brl = /R\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/gi;
  for (const m of text.matchAll(brl)) out.push(toCents(m[1], m[2]));
  const reais = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:reais|real)\b/gi;
  for (const m of text.matchAll(reais)) out.push(toCents(m[1], m[2]));
  return out;
}

function toCents(int: string | undefined, dec: string | undefined) {
  const whole = Number((int ?? "0").replace(/\./g, ""));
  const cents = dec ? Number(dec.padEnd(2, "0")) : 0;
  return whole * 100 + cents;
}

// ---------- horário comercial ----------

function parseHm(value: string) {
  const [h = "0", m = "0"] = value.split(":");
  return Number(h) * 60 + Number(m);
}

function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function isWithinBusinessHours(date: Date, hours: BusinessHours) {
  const { weekday, minutes } = localParts(date, hours.timeZone);
  const window = hours.days[weekday];
  if (!window) return false;
  return minutes >= parseHm(window[0]) && minutes < parseHm(window[1]);
}

/** Próximo instante dentro do horário comercial (passos de 15 min, até 14 dias); se não houver, devolve `from`. */
export function nextBusinessTime(from: Date, hours: BusinessHours) {
  const step = 15 * 60_000;
  for (let t = from.getTime(); t < from.getTime() + 14 * 24 * 3_600_000; t += step) {
    if (isWithinBusinessHours(new Date(t), hours)) return new Date(t);
  }
  return from;
}

// ---------- valores monetários, descontos e parcelas (guardrail de preço) ----------

export type MoneyClaim = { kind: "money" | "percent" | "installments"; value: number };

const NUM = String.raw`(\d{1,3}(?:\.\d{3})+|\d+)(?:[,.](\d{1,2}))?`;
const SLANG = String.raw`reais|real|pilas?|contos?|mangos?|paus?|bufunfa|grana|d[oó]lar(?:es)?|euros?|brl|usd`;
const NOT_A_PRICE_UNIT = String.raw`(?!\s*(?:min|minutos?|horas?|hrs?|h\b|dias?|semanas?|meses|m[eê]s|anos?|vezes|vagas?|pessoas?|unidades?|sess(?:ao|oes|ão|ões)|consultas?|aulas?|km|kg|metros?|cm\b|mm\b|ml\b|itens?|fotos?|arquivos?|passos?|etapas?|op[cç](?:ao|oes|ão|ões)|fatores?|tipos?|dentes?|c[oó]pias?))`;
const CONTEXT_WORDS = String.raw`desconto|descontos|promo[cç](?:ao|ão)|parcelas?|entrada|mensalidades?|taxa|valor|valores|pre[cç]os?|custa|custam|custo|sai|fica|ficou|apenas|somente|s[oó]|total|cobramos|cobrado|investimento`;

function claimFrom(int: string | undefined, dec: string | undefined, thousand = false) {
  const cents = toCents(int, dec);
  return thousand ? cents * 1000 : cents;
}

/**
 * Todo número que funciona como preço, desconto ou parcela: "R$ 300", "BRL 50", "$ 300", "300 pilas", "300 conto",
 * "só 300,00", "3x de 100", "50% de desconto", "20 de desconto". Usado para exigir que o valor exista no conhecimento.
 */
export function extractMonetaryClaims(text: string): MoneyClaim[] {
  const out: MoneyClaim[] = [];
  const add = (kind: MoneyClaim["kind"], value: number) => out.push({ kind, value });
  const re = (src: string) => new RegExp(src, "giu");

  for (const m of text.matchAll(re(String.raw`(?:r\$|us\$|brl|usd|\$)\s?${NUM}(\s?mil\b)?`))) add("money", claimFrom(m[1], m[2], !!m[3]));
  for (const m of text.matchAll(re(String.raw`${NUM}(\s?mil)?\s*(?:${SLANG})\b`))) add("money", claimFrom(m[1], m[2], !!m[3]));
  for (const m of text.matchAll(re(String.raw`\b(\d{1,2})\s?x\s*(?:de\s*)?(?:r\$\s?)?${NUM}${NOT_A_PRICE_UNIT}`))) {
    add("installments", Number(m[1]));
    add("money", claimFrom(m[2], m[3]));
  }
  for (const m of text.matchAll(re(String.raw`\b(\d{1,2})\s?x\b(?!\s*\d)`))) add("installments", Number(m[1]));
  for (const m of text.matchAll(re(String.raw`\b(\d{1,2})\s+(?:vezes|parcelas|presta[cç](?:ao|ões|ão))\s+(?:de|sem|no)\b`))) add("installments", Number(m[1]));
  for (const m of text.matchAll(re(String.raw`${NUM}\s?(?:%|por\s?cento)`))) add("percent", Number((m[1] ?? "0").replace(/\./g, "")) + (m[2] ? Number(m[2]) / 100 : 0));
  // número solto perto de palavra de preço: "desconto de 90", "só 300,00", "parcelas de 50"
  for (const m of text.matchAll(re(String.raw`\b(?:${CONTEXT_WORDS})\s+(?:(?:de|do|da|por|em|a|é|e|ficou|fica|sai|seria|será)\s+){0,2}(?:r\$\s?)?${NUM}(?!\s?%)${NOT_A_PRICE_UNIT}`))) {
    add("money", claimFrom(m[1], m[2]));
  }
  for (const m of text.matchAll(re(String.raw`${NUM}\s+(?:de\s+)?(?:desconto|off\b|de entrada|por m[eê]s|mensais|ao m[eê]s|[aà] vista|de taxa)`))) add("money", claimFrom(m[1], m[2]));
  return out;
}
