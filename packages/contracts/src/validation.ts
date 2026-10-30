// Validação e máscara de telefone e e-mail, usadas pelos formulários (aviso na hora) e pela API (regra de verdade).
// Sem React nem rede: a mesma função decide nos dois lados, então a tela nunca aceita o que a API recusa.

export const PHONE_ERROR = "Telefone inválido. Use DDD + número, ex.: (67) 99812-3456.";
export const EMAIL_ERROR = "E-mail inválido. Confira se tem @ e o final, ex.: nome@empresa.com.br.";

/** Só os dígitos (e um "+" no começo, se houver). É o formato que a API guarda e confere. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

/** Parte nacional de um número brasileiro (sem o 55), ou null se não for brasileiro. */
function brazilianNational(normalized: string): string | null {
  const digits = normalized.replace(/\D/g, "");
  if (normalized.startsWith("+")) {
    return digits.startsWith("55") ? digits.slice(2) : null;
  }
  // sem "+": 55 na frente só conta quando sobra um número completo (12 ou 13 dígitos)
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) return digits.slice(2);
  return digits;
}

/**
 * Telefone válido: vazio (campo opcional) ou
 *  - Brasil: DDD (11–99) + 8 dígitos fixo/celular antigo, ou + 9 dígitos começando em 9, com ou sem +55;
 *  - fora do Brasil: precisa começar com "+" e ter de 8 a 15 dígitos (padrão internacional).
 */
export function isValidPhone(raw: string): boolean {
  if (raw.trim() === "") return true;
  // letras e símbolos soltos (ex.: "99812-3456 ramal 2") não viram número em silêncio
  if (/[^\d\s()+\-.]/.test(raw)) return false;
  const normalized = normalizePhone(raw);
  if (normalized === "" || normalized === "+") return false;
  const national = brazilianNational(normalized);
  if (national === null) {
    const digits = normalized.slice(1);
    return digits.length >= 8 && digits.length <= 15;
  }
  if (!/^[1-9][1-9]\d+$/.test(national)) return false;
  if (national.length === 10) return /^\d{2}[2-9]/.test(national);
  if (national.length === 11) return national[2] === "9";
  return false;
}

/**
 * Máscara enquanto digita: "(67) 99812-3456", "(67) 3333-4444", "+55 (67) 99812-3456" e, fora do Brasil, "+1415…".
 * Apagar funciona porque nunca sobra enfeite no fim: "(67" não vira "(67) " até vir o próximo dígito.
 */
export function formatPhoneInput(raw: string): string {
  const normalized = normalizePhone(raw);
  const digits = normalized.replace(/\D/g, "");
  if (digits === "") return normalized === "+" ? "+" : "";

  let prefix = "";
  let national = digits;
  if (normalized.startsWith("+")) {
    if (!digits.startsWith("55")) return `+${digits.slice(0, 15)}`;
    prefix = "+55 ";
    national = digits.slice(2);
  } else if (digits.length > 11 && digits.startsWith("55")) {
    national = digits.slice(2);
  }
  national = national.slice(0, 11);

  const ddd = national.slice(0, 2);
  const rest = national.slice(2);
  if (national.length <= 2) return `${prefix}(${ddd}`;
  // 11 dígitos = celular com 9: 5+4. Até 10 dígitos = 4+4 (mostra o hífen só depois do 4º dígito do número)
  const split = national.length === 11 ? 5 : 4;
  const head = rest.slice(0, split);
  const tail = rest.slice(split);
  return `${prefix}(${ddd}) ${head}${tail ? `-${tail}` : ""}`;
}

/** Mensagem de erro do telefone, ou null se estiver ok (ou vazio e opcional). */
export function phoneError(raw: string, opts: { required?: boolean } = {}): string | null {
  if (raw.trim() === "") return opts.required ? "Informe o telefone." : null;
  return isValidPhone(raw) ? null : PHONE_ERROR;
}

// ── E-mail ────────────────────────────────────────────────────────────────────

// Mesma regra do `z.email()` do Zod 4 (a API valida com ele): o aviso da tela e a recusa do servidor nunca divergem.
const EMAIL_PATTERN = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

export function isValidEmail(raw: string): boolean {
  const value = raw.trim();
  return value.length <= 254 && EMAIL_PATTERN.test(value);
}

// Erros de digitação comuns nos provedores mais usados.
const DOMAIN_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.com.br": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "hotamil.com": "hotmail.com",
  "outlok.com": "outlook.com",
  "outlook.con": "outlook.com",
  "yaho.com": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "yahoo.com.br.br": "yahoo.com.br",
  "icloud.con": "icloud.com",
};

/** "Quis dizer nome@gmail.com?" quando o domínio parece um erro de digitação; senão null. */
export function emailSuggestion(raw: string): string | null {
  const value = raw.trim();
  const at = value.lastIndexOf("@");
  if (at < 1) return null;
  const fix = DOMAIN_TYPOS[value.slice(at + 1).toLowerCase()];
  return fix ? `${value.slice(0, at)}@${fix}` : null;
}

/** Mensagem de erro do e-mail, ou null se estiver ok (ou vazio e opcional). */
export function emailError(raw: string, opts: { required?: boolean } = {}): string | null {
  if (raw.trim() === "") return opts.required ? "Informe o e-mail." : null;
  return isValidEmail(raw) ? null : EMAIL_ERROR;
}
