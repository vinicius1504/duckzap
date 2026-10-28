import type { ApiKey, ApiKeyScope, CreateApiKeyInput, CreatedApiKey } from "@duckzap/contracts/settings";
import { apiKeyScopeSchema } from "@duckzap/contracts/settings";
import { schema, withOrg } from "@duckzap/db";
import { and, desc, eq, isNull, or, lt } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { v7 as uuidv7 } from "uuid";
import { generateSecret, hashApiKey, lastFour } from "../../lib/crypto";
import type { Deps } from "../../lib/context";
import { fail } from "../team/http";
import { errRes, okRes, type Res } from "../team/result";

export const API_KEY_PREFIX = "dz_live_";

/** Segredo: `dz_live_<organizationId>.<32 bytes aleatórios>`. O id da empresa não é segredo; serve para achar o tenant. */
export function newApiKeySecret(organizationId: string) {
  return generateSecret(`${API_KEY_PREFIX}${organizationId}.`);
}

/** Extrai a empresa do segredo sem tocar no banco; null se o formato não bater. */
export function organizationIdFromApiKey(secret: string): string | null {
  if (!secret.startsWith(API_KEY_PREFIX)) return null;
  const rest = secret.slice(API_KEY_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot < 1 || dot === rest.length - 1) return null;
  return rest.slice(0, dot);
}

function toApiKey(row: typeof schema.apiKeys.$inferSelect): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    last4: row.last4,
    scopes: row.scopes.flatMap((s) => {
      const parsed = apiKeyScopeSchema.safeParse(s);
      return parsed.success ? [parsed.data] : [];
    }),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function listApiKeys(deps: Deps, organizationId: string): Promise<ApiKey[]> {
  const rows = await withOrg(deps.db, organizationId, (tx) =>
    tx.select().from(schema.apiKeys).where(eq(schema.apiKeys.organizationId, organizationId)).orderBy(desc(schema.apiKeys.createdAt)),
  );
  return rows.map(toApiKey);
}

/** Cria a chave. O segredo completo só existe nesta resposta; no banco fica o hash. */
export async function createApiKey(deps: Deps, organizationId: string, input: CreateApiKeyInput): Promise<CreatedApiKey> {
  const secret = newApiKeySecret(organizationId);
  const [row] = await withOrg(deps.db, organizationId, (tx) =>
    tx
      .insert(schema.apiKeys)
      .values({
        id: uuidv7(),
        organizationId,
        name: input.name,
        prefix: API_KEY_PREFIX,
        last4: lastFour(secret),
        keyHash: hashApiKey(secret),
        scopes: input.scopes,
      })
      .returning(),
  );
  if (!row) throw new Error("Falha ao criar a chave");
  return { apiKey: toApiKey(row), secret };
}

export async function revokeApiKey(deps: Deps, organizationId: string, id: string): Promise<Res<null>> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return errRes(404, "not_found", "Chave não encontrada.");
  const rows = await withOrg(deps.db, organizationId, (tx) =>
    tx
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.apiKeys.organizationId, organizationId), eq(schema.apiKeys.id, id), isNull(schema.apiKeys.revokedAt)))
      .returning({ id: schema.apiKeys.id }),
  );
  if (rows.length > 0) return okRes(null);
  // já revogada conta como sucesso; de outra empresa ou inexistente é 404
  const [existing] = await withOrg(deps.db, organizationId, (tx) =>
    tx
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.organizationId, organizationId), eq(schema.apiKeys.id, id))),
  );
  return existing ? okRes(null) : errRes(404, "not_found", "Chave não encontrada.");
}

export type ApiKeyPrincipal = { organizationId: string; keyId: string; scopes: ApiKeyScope[] };
export type ApiKeyBindings = { Variables: { apiKey: ApiKeyPrincipal } };

/** Lê o segredo de `Authorization: Bearer …` ou `X-API-Key`. */
export function extractApiKey(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  return headers.get("x-api-key")?.trim() || null;
}

/**
 * Autenticação por chave de API para rotas públicas do cliente (outro módulo pode usar):
 *   app.use("/public/*", requireApiKey(deps, "contacts:read"))
 * Procura pelo hash dentro do tenant que vem do próprio segredo; chave revogada, inexistente ou de formato
 * inválido respondem igual (401), sem revelar qual caso foi. Atualiza `last_used_at` no máximo 1x por minuto.
 */
export function requireApiKey(deps: Deps, ...required: ApiKeyScope[]): MiddlewareHandler<ApiKeyBindings> {
  return async (c, next) => {
    const unauthorized = () => fail(c, 401, "unauthorized", "Chave de API inválida ou revogada.");
    const secret = extractApiKey(c.req.raw.headers);
    const organizationId = secret ? organizationIdFromApiKey(secret) : null;
    if (!secret || !organizationId) return unauthorized();

    const row = await withOrg(deps.db, organizationId, async (tx) => {
      const [found] = await tx
        .select()
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.organizationId, organizationId),
            eq(schema.apiKeys.keyHash, hashApiKey(secret)),
            isNull(schema.apiKeys.revokedAt),
          ),
        );
      if (found) {
        const stale = new Date(Date.now() - 60_000);
        await tx
          .update(schema.apiKeys)
          .set({ lastUsedAt: new Date() })
          .where(
            and(
              eq(schema.apiKeys.organizationId, organizationId),
              eq(schema.apiKeys.id, found.id),
              or(isNull(schema.apiKeys.lastUsedAt), lt(schema.apiKeys.lastUsedAt, stale)),
            ),
          );
      }
      return found ?? null;
    });
    if (!row) return unauthorized();

    const scopes = toApiKey(row).scopes;
    if (!required.every((s) => scopes.includes(s))) return fail(c, 403, "forbidden", "Esta chave não tem permissão para isso.");
    c.set("apiKey", { organizationId, keyId: row.id, scopes });
    await next();
  };
}
