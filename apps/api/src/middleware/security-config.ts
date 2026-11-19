import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? fallback : value === "true"));

export type SecurityConfig = {
  /** Opcional: Proprietário/Administrador só usa o produto com 2FA ativo (§5.1). Desligado por padrão: o 2FA é recomendado, não obrigatório. */
  require2faForAdmins: boolean;
  /** A API está atrás de proxy confiável que acrescenta o IP real ao FIM de x-forwarded-for. */
  trustProxy: boolean;
};

/**
 * Lido aqui (convenção: sem mexer em src/env.ts).
 * - `REQUIRE_2FA_FOR_ADMINS`: padrão `false` em QUALQUER ambiente (o 2FA é opcional e recomendado no cadastro e em Minha conta).
 *   Ligue (`true`) só se quiser voltar a exigir de Proprietário/Administrador.
 * - `TRUST_PROXY`: padrão `false`. Ligue só atrás de proxy confiável (Caddy); ver docs/runbooks.
 */
export function loadSecurityConfig(source: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const parsed = z
    .object({ REQUIRE_2FA_FOR_ADMINS: bool(false), TRUST_PROXY: bool(false) })
    .parse({ REQUIRE_2FA_FOR_ADMINS: source.REQUIRE_2FA_FOR_ADMINS, TRUST_PROXY: source.TRUST_PROXY });
  return { require2faForAdmins: parsed.REQUIRE_2FA_FOR_ADMINS, trustProxy: parsed.TRUST_PROXY };
}
