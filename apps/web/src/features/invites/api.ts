import "server-only";
import { memberRoleSchema } from "@duckzap/contracts/session";
import { z } from "zod";
import { apiFetch, forwardSetCookies } from "@/lib/api-server";
import { fail, ok, type Result } from "@/lib/mock";

// Ligado ao back (apps/api/src/modules/team/invites.ts): GET /v1/invites/:id e POST /v1/invites/:id/accept.
// Rotas públicas: o parâmetro do link é o que o e-mail trouxe (hoje o id do convite; pode virar um token).
// Aqui NÃO se usa `callApi`: ele manda qualquer 401 para o login, e `login_required` é uma resposta esperada.

const UNAVAILABLE = "Não conseguimos falar com o servidor. Tente de novo em instantes.";

export const inviteInfoSchema = z.object({
  organizationName: z.string(),
  email: z.string(),
  name: z.string(),
  role: memberRoleSchema,
  /** Já existe conta com esse e-mail: a tela pede login em vez de senha nova. */
  hasAccount: z.boolean(),
});
export type InviteInfo = z.infer<typeof inviteInfoSchema>;

const path = (token: string) => `/v1/invites/${encodeURIComponent(token.slice(0, 128))}`;

async function readError(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null;
  return {
    code: typeof body?.error?.code === "string" ? body.error.code : "",
    message: typeof body?.error?.message === "string" ? body.error.message : "Algo deu errado. Tente de novo.",
  };
}

export async function getInvite(token: string): Promise<Result<InviteInfo, "not_found" | "unavailable">> {
  let response: Response;
  try {
    response = await apiFetch(path(token));
  } catch {
    return fail("unavailable", UNAVAILABLE);
  }
  if (response.status === 404) return fail("not_found", (await readError(response)).message);
  if (response.status === 429) return fail("unavailable", "Muitas tentativas. Aguarde um minuto e tente de novo.");
  if (!response.ok) return fail("unavailable", UNAVAILABLE);
  const parsed = inviteInfoSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? ok(parsed.data) : fail("unavailable", "A resposta do servidor veio em um formato inesperado.");
}

export type AcceptError = "login_required" | "forbidden" | "validation_error" | "not_found" | "unavailable";

export async function acceptInvite(token: string, password?: string): Promise<Result<null, AcceptError>> {
  let response: Response;
  try {
    response = await apiFetch(`${path(token)}/accept`, {
      method: "POST",
      body: JSON.stringify(password ? { password } : {}),
    });
  } catch {
    return fail("unavailable", UNAVAILABLE);
  }
  if (response.status === 429) return fail("unavailable", "Muitas tentativas. Aguarde um minuto e tente de novo.");
  if (!response.ok) {
    const { code, message } = await readError(response);
    const known: AcceptError[] = ["login_required", "forbidden", "validation_error", "not_found"];
    return fail(known.find((k) => k === code) ?? "unavailable", message);
  }
  // a API devolve a sessão (conta nova) ou renova a existente
  await forwardSetCookies(response);
  await response.body?.cancel();
  return ok(null);
}
