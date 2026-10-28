import { signUpSchema } from "@duckzap/contracts/onboarding";
import { schema, withOrg } from "@duckzap/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../../lib/context";
import { parseInviteToken } from "./invite-token";
import { fromBetterAuthRole } from "./rules";
import { errRes, okRes, type Res } from "./result";

/**
 * Aceite de convite, sem sessão obrigatória (a pessoa pode ainda não ter conta). O "segredo" é o token do link
 * (`<id>.<assinatura>`, ver invite-token.ts), enviado só ao e-mail convidado; o id sozinho, que a Equipe vê, não vale. Esta é a ÚNICA leitura de `invitation` sem filtro de
 * empresa de entrada, e ela já traz a empresa do próprio convite e passa a usá-la em todo o resto.
 */

export const acceptInviteBodySchema = z.object({
  /** Só para quem ainda não tem conta. */
  password: signUpSchema.shape.password.optional(),
});

export type InviteInfo = {
  organizationName: string;
  email: string;
  name: string;
  role: ReturnType<typeof fromBetterAuthRole>;
  /** Já existe conta com esse e-mail: a tela pede login em vez de senha nova. */
  hasAccount: boolean;
};

async function loadPending(deps: Deps, token: string) {
  // o link traz `<id>.<assinatura>`; o id puro (que a tela de Equipe mostra) não aceita nada
  const invitationId = parseInviteToken(deps.env.BETTER_AUTH_SECRET, token);
  if (!invitationId) return null;
  const [row] = await deps.db
    .select({
      id: schema.invitation.id,
      organizationId: schema.invitation.organizationId,
      email: schema.invitation.email,
      role: schema.invitation.role,
      status: schema.invitation.status,
      expiresAt: schema.invitation.expiresAt,
      organizationName: schema.organization.name,
    })
    .from(schema.invitation)
    .innerJoin(schema.organization, eq(schema.invitation.organizationId, schema.organization.id))
    .where(eq(schema.invitation.id, invitationId))
    .limit(1);
  if (!row || row.status !== "pending" || row.expiresAt < new Date()) return null;
  return row;
}

export async function getInviteInfo(deps: Deps, token: string): Promise<Res<InviteInfo>> {
  const invite = await loadPending(deps, token);
  if (!invite) return errRes(404, "not_found", "Este convite não existe mais ou expirou. Peça um novo para quem convidou você.");
  const [profile] = await withOrg(deps.db, invite.organizationId, (tx) =>
    tx
      .select({ name: schema.inviteProfiles.name })
      .from(schema.inviteProfiles)
      .where(and(eq(schema.inviteProfiles.organizationId, invite.organizationId), eq(schema.inviteProfiles.invitationId, invite.id))),
  );
  const [existing] = await deps.db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(sql`lower(${schema.user.email}) = ${invite.email.toLowerCase()}`)
    .limit(1);
  return okRes({
    organizationName: invite.organizationName,
    email: invite.email,
    name: profile?.name ?? invite.email,
    role: fromBetterAuthRole(invite.role ?? "member"),
    hasAccount: Boolean(existing),
  });
}

function cookieHeaderFrom(response: Response) {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

export type AcceptResult = { organizationId: string; setCookies: string[] };

export async function acceptInvite(
  deps: Deps,
  input: { token: string; headers: Headers; password?: string | undefined },
): Promise<Res<AcceptResult>> {
  const invite = await loadPending(deps, input.token);
  if (!invite) return errRes(404, "not_found", "Este convite não existe mais ou expirou. Peça um novo para quem convidou você.");

  const session = await deps.auth.api.getSession({ headers: input.headers });
  const setCookies: string[] = [];
  let acceptHeaders = input.headers;

  if (session) {
    if (session.user.email.toLowerCase() !== invite.email.toLowerCase()) {
      return errRes(403, "forbidden", `Este convite é para ${invite.email}. Saia e entre com esse e-mail.`);
    }
  } else {
    const [existing] = await deps.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(sql`lower(${schema.user.email}) = ${invite.email.toLowerCase()}`)
      .limit(1);
    if (existing) return errRes(401, "login_required", "Você já tem conta. Entre com ela para aceitar o convite.");
    if (!input.password) return errRes(422, "validation_error", "Crie uma senha para aceitar o convite.");

    const [profile] = await withOrg(deps.db, invite.organizationId, (tx) =>
      tx
        .select({ name: schema.inviteProfiles.name })
        .from(schema.inviteProfiles)
        .where(and(eq(schema.inviteProfiles.organizationId, invite.organizationId), eq(schema.inviteProfiles.invitationId, invite.id))),
    );
    const signUp = await deps.auth.api.signUpEmail({
      body: { name: profile?.name ?? invite.email, email: invite.email, password: input.password },
      asResponse: true,
    });
    if (!signUp.ok) return errRes(422, "validation_error", "Não conseguimos criar sua conta. Confira a senha e tente de novo.");
    // o convite chegou nesse e-mail: a posse do endereço está provada
    await deps.db.update(schema.user).set({ emailVerified: true }).where(sql`lower(${schema.user.email}) = ${invite.email.toLowerCase()}`);
    setCookies.push(...signUp.headers.getSetCookie());
    acceptHeaders = new Headers({ cookie: cookieHeaderFrom(signUp) });
  }

  const accepted = await deps.auth.api.acceptInvitation({ headers: acceptHeaders, body: { invitationId: invite.id }, asResponse: true });
  if (!accepted.ok) return errRes(409, "invalid_state", "Não foi possível aceitar o convite. Peça um novo para quem convidou você.");
  setCookies.push(...accepted.headers.getSetCookie());

  // a referência da pessoa nas equipes passa do id do convite para o id do usuário
  const [user] = await deps.db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(sql`lower(${schema.user.email}) = ${invite.email.toLowerCase()}`)
    .limit(1);
  if (user) {
    await withOrg(deps.db, invite.organizationId, async (tx) => {
      await tx
        .update(schema.teamMembers)
        .set({ memberRef: user.id })
        .where(and(eq(schema.teamMembers.organizationId, invite.organizationId), eq(schema.teamMembers.memberRef, invite.id)));
    });
  }
  return okRes({ organizationId: invite.organizationId, setCookies });
}
