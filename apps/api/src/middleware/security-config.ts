import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? fallback : value === "true"));

export type SecurityConfig = {
  /** Proprietário/Administrador precisa ter 2FA para usar o produto (§5.1). */
  require2faForAdmins: boolean;
  /** A API está atrás de proxy confiável que acrescenta o IP real ao FIM de x-forwarded-for. */
  trustProxy: boolean;
};

/**
 * Lido aqui (convenção: sem mexer em src/env.ts).
 * - `REQUIRE_2FA_FOR_ADMINS`: padrão `true` em produção e `false` em dev/test (não trava o seed).
 * - `TRUST_PROXY`: padrão `false`. Ligue só atrás de proxy confiável (Caddy); ver docs/runbooks.
 */
export function loadSecurityConfig(source: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const production = source.NODE_ENV === "production";
  const parsed = z
    .object({ REQUIRE_2FA_FOR_ADMINS: bool(production), TRUST_PROXY: bool(false) })
    .parse({ REQUIRE_2FA_FOR_ADMINS: source.REQUIRE_2FA_FOR_ADMINS, TRUST_PROXY: source.TRUST_PROXY });
  return { require2faForAdmins: parsed.REQUIRE_2FA_FOR_ADMINS, trustProxy: parsed.TRUST_PROXY };
}
