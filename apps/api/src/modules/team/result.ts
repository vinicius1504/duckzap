import { createMailer, type Mailer } from "../../lib/mailer";
import type { Env } from "../../env";

export type ServiceStatus = 400 | 401 | 403 | 404 | 409 | 422;
export type ServiceError = { code: string; message: string; status: ServiceStatus };
export type Res<T> = { ok: true; data: T } | { ok: false; error: ServiceError };

export const okRes = <T>(data: T): Res<T> => ({ ok: true, data });
export const errRes = (status: ServiceStatus, code: string, message: string): { ok: false; error: ServiceError } => ({
  ok: false,
  error: { code, message, status },
});

/** Status HTTP por código de regra de negócio (padrão do docs/backend-conventions.md). */
export function statusFor(code: string): ServiceStatus {
  if (code === "not_found") return 404;
  if (code === "forbidden" || code === "plan_limit") return 403;
  if (code === "validation_error" || code === "invalid_members" || code === "invalid_teams") return 422;
  return 409;
}

const mailers = new WeakMap<Env, Mailer>();

/** Um transporte de e-mail por configuração (o `Deps` não carrega o mailer). */
export function mailerFor(env: Env): Mailer {
  let mailer = mailers.get(env);
  if (!mailer) {
    mailer = createMailer(env);
    mailers.set(env, mailer);
  }
  return mailer;
}
