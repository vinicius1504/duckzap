import { brand } from "@duckzap/brand";

// 2FA por CÓDIGO NO E-MAIL (`otpOptions` do plugin twoFactor do Better Auth). O código é de 6 números, vale
// `OTP_PERIOD_MINUTES`, é guardado só como hash e aceita 5 tentativas (depois pede outro).

export const OTP_PERIOD_MINUTES = 5;

/** Texto do e-mail com o código: sem dado da conta além do nome (nada de IP, empresa ou link). */
export function twoFactorEmailMessage(name: string, code: string) {
  return {
    subject: `Seu código de acesso ao ${brand.name}`,
    text: `Oi, ${name}!

Seu código de verificação é: ${code}

Ele vale por ${OTP_PERIOD_MINUTES} minutos e só funciona uma vez. Não passe este código para ninguém: a equipe do ${brand.name} nunca pede.

Se não foi você que tentou entrar, troque sua senha em Ajustes › Minha conta.`,
  };
}

export type OtpEmailLimit = {
  /** Espera mínima entre dois envios para a mesma pessoa. */
  cooldownMs: number;
  /** Máximo de envios por pessoa dentro de `windowMs`. */
  max: number;
  windowMs: number;
};

export const DEFAULT_OTP_EMAIL_LIMIT: OtpEmailLimit = { cooldownMs: 30_000, max: 5, windowMs: 15 * 60_000 };

/**
 * Anti-abuso do envio (além do limite por IP do Better Auth): por PESSOA, 1 e-mail a cada 30 s e 5 a cada 15 min.
 * Em memória, como o aviso de "conta já existe" (uma instância da API). `take` conta o envio quando libera.
 */
export function createOtpEmailLimiter(limit: OtpEmailLimit = DEFAULT_OTP_EMAIL_LIMIT, now: () => number = Date.now) {
  const sent = new Map<string, number[]>();
  return {
    /** null = pode enviar (e já conta este envio); senão, a mensagem para a tela. */
    take(userId: string): string | null {
      const current = now();
      const recent = (sent.get(userId) ?? []).filter((t) => t > current - limit.windowMs);
      const last = recent[recent.length - 1];
      if (last !== undefined && current - last < limit.cooldownMs) {
        return "Acabamos de enviar um código. Aguarde alguns segundos para pedir outro.";
      }
      if (recent.length >= limit.max) return "Você pediu muitos códigos. Aguarde alguns minutos e tente de novo.";
      recent.push(current);
      sent.set(userId, recent);
      if (sent.size > 10_000) for (const [k, list] of sent) if (list.every((t) => t <= current - limit.windowMs)) sent.delete(k);
      return null;
    },
  };
}
