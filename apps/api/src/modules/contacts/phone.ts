export type PhoneResult = { ok: true; phone: string } | { ok: false; reason: "no_phone" | "invalid_phone" };

/**
 * Telefone digitado/planilha → E.164. DDD + número (10–11 dígitos) vira +55…; 12–13 dígitos já trazem o país;
 * com "+" aceita 10–15 dígitos. Vazio é `no_phone`; o resto é `invalid_phone`.
 */
export function normalizePhone(raw: string): PhoneResult {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "no_phone" };
  if (trimmed.startsWith("+")) {
    return digits.length >= 10 && digits.length <= 15 ? { ok: true, phone: `+${digits}` } : { ok: false, reason: "invalid_phone" };
  }
  if (digits.length === 10 || digits.length === 11) return { ok: true, phone: `+55${digits}` };
  if (digits.length === 12 || digits.length === 13) return { ok: true, phone: `+${digits}` };
  return { ok: false, reason: "invalid_phone" };
}
