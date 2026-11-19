import type { TwoFactorMethod } from "@duckzap/contracts/settings";

// Regras PURAS da verificação em duas etapas (sem servidor), usadas no cadastro, em Minha conta e no login.

/** Códigos de 6 números: tira espaços e traços que a pessoa digita ou cola ("123 456", "123-456"). */
export const normalizeCode = (code: string) => code.replace(/[\s-]/g, "");

/**
 * No login, o Better Auth diz que métodos valem para a conta (`twoFactorMethods`). Com "totp" a pessoa usa o app
 * autenticador (o servidor nem manda código por e-mail para ela); só com "otp", recebe o código por e-mail.
 * Resposta sem a lista (versão antiga): app, como antes.
 */
export function signInMethod(methods: unknown): TwoFactorMethod {
  if (!Array.isArray(methods)) return "app";
  if (methods.includes("totp")) return "app";
  return methods.includes("otp") ? "email" : "app";
}

export const methodLabels: Record<TwoFactorMethod, string> = {
  app: "App autenticador",
  email: "Código por e-mail",
};

/** Frase curta de como fica o login com cada método. */
export const methodSignInHint: Record<TwoFactorMethod, string> = {
  app: "Ao entrar, pedimos o código de 6 números do app autenticador.",
  email: "Ao entrar, enviamos um código de 6 números para o seu e-mail.",
};

/** O outro método (para "Trocar para…"). */
export const otherMethod = (method: TwoFactorMethod): TwoFactorMethod => (method === "app" ? "email" : "app");
