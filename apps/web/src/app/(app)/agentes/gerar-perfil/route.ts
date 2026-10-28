import { agentGeneratorInputSchema } from "@duckzap/contracts/agents";
import { can } from "@duckzap/contracts/permissions";
import { NextResponse } from "next/server";
import { generateAgentProfile, type GenerateAgentResult } from "@/features/agents/api";
import { getSession } from "@/features/auth/session";
import { failure, formatCount, isGeneratorField, type GeneratorFieldErrors } from "@/lib/agent-generator";

// Gerar o perfil do agente leva ~20–25 s e pode chegar a ~2 min (a API desiste em 270 s). Por isso isto é uma rota (POST) e
// não uma Server Action: o navegador pode CANCELAR de verdade (o `request.signal` aborta a chamada à API) e a espera não
// trava a fila de ações/navegação do Next, que roda uma Server Action por vez.
// Em hospedagem própria (`next start`/standalone) não há limite de função; atrás de proxy reverso (Caddy, Nginx,
// Cloudflare) o tempo de leitura precisa ser maior que 290 s para esta rota. Na Vercel, `maxDuration` vale.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const json = (body: GenerateAgentResult) => NextResponse.json(body, { headers: { "cache-control": "no-store" } });

/** A rota usa o cookie de sessão: só aceita chamadas feitas pelo próprio site (como as Server Actions fazem). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request) || !(request.headers.get("content-type") ?? "").includes("application/json")) {
    return json({ ok: false, error: failure("forbidden", { message: "Pedido não autorizado." }) });
  }
  const session = await getSession();
  if (!session) return json({ ok: false, error: failure("forbidden", { message: "Sua sessão expirou. Entre de novo para continuar.", retryable: false, gate: "login" }) });
  if (!can(session.user.role, "agent.manage")) return json({ ok: false, error: failure("forbidden") });

  const body: unknown = await request.json().catch(() => null);
  const parsed = agentGeneratorInputSchema.safeParse(body);
  if (!parsed.success) {
    const fields: GeneratorFieldErrors = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (isGeneratorField(key)) fields[key] ??= issue.code === "too_big" ? `Passou do limite de ${formatCount(Number(issue.maximum))} caracteres.` : issue.message;
    }
    return json({ ok: false, error: failure("invalid_input", { fields }) });
  }
  return json(await generateAgentProfile(parsed.data, request.signal));
}
