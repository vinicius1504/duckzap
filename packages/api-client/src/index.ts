import type { AppType } from "@duckzap/api/app-type";
import { hc } from "hono/client";

/**
 * Cliente tipado da API. Os fronts chamam `/api` no próprio domínio, e o proxy
 * (rewrite do Next em dev, Caddy em produção) encaminha para o serviço da API,
 * esteja ele na mesma VPS ou em outra.
 */
export function createApiClient(baseUrl: string, init?: RequestInit) {
  return hc<AppType>(baseUrl, {
    init: { credentials: "include", ...init },
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;
