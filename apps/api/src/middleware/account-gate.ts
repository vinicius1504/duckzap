import { isAccountSuspended, type Session } from "@duckzap/contracts/session";
import { isTwoFactorExemptPath, TWO_FACTOR_REQUIRED } from "./two-factor";

export const ACCOUNT_SUSPENDED = {
  error: {
    code: "account_suspended",
    message: "Sua conta está suspensa por falta de pagamento. Faça o acerto de contas para voltar a usar o sistema.",
  },
} as const;

/** Rotas que continuam abertas com a conta suspensa: sessão, conta, cobrança/planos, convites e cadastro (Better Auth e webhooks nem passam aqui). */
const SUSPENDED_EXEMPT = /^\/v1\/(me|account|settings\/billing|settings\/plans|invites|onboarding|auth)(\/|$)/;
export const isSuspendedExemptPath = (path: string) => SUSPENDED_EXEMPT.test(path);

export type GateDecision = { status: 403; body: typeof ACCOUNT_SUSPENDED | typeof TWO_FACTOR_REQUIRED } | null;

/** Ponto único: conta suspensa e 2FA obrigatório, sobre a sessão do produto já montada. */
export function accessGate(session: Session, path: string): GateDecision {
  if (isAccountSuspended(session.organization.subscriptionStatus) && !isSuspendedExemptPath(path)) {
    return { status: 403, body: ACCOUNT_SUSPENDED };
  }
  if (session.user.twoFactorRequired && !isTwoFactorExemptPath(path)) return { status: 403, body: TWO_FACTOR_REQUIRED };
  return null;
}
