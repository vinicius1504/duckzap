import type { MemberRole } from "@duckzap/contracts/session";

/**
 * Regras de papel da Equipe (§5.1). É a mesma regra de `apps/web/src/features/team/rules.ts`:
 * a tela só esconde/desabilita; quem autoriza de verdade é este arquivo.
 * - Só o proprietário cria proprietários.
 * - Só o proprietário mexe em proprietários e administradores (papel, inativar, cancelar convite).
 * - Administrador pode convidar ou promover atendentes a administrador.
 */
export function canAssignRole(actor: MemberRole, role: MemberRole) {
  if (actor === "owner") return true;
  return actor === "admin" && role !== "owner";
}

export function canManageMember(actor: MemberRole, target: { role: MemberRole }) {
  if (actor === "owner") return true;
  return actor === "admin" && target.role === "agent";
}

/** Better Auth guarda o Atendente como `member`. */
export function toBetterAuthRole(role: MemberRole): "owner" | "admin" | "member" {
  return role === "agent" ? "member" : role;
}

export function fromBetterAuthRole(role: string): MemberRole {
  if (role === "owner" || role === "admin") return role;
  return "agent";
}

export type RuleViolation = { code: "forbidden" | "last_owner" | "self"; message: string };

type Person = { id: string; role: MemberRole };

/** Mudança de papel de uma pessoa (a regra "último proprietário ativo" precisa de quantos existem). */
export function checkRoleChange(input: {
  actor: MemberRole;
  target: Person;
  newRole: MemberRole;
  activeOwnerCount: number;
}): RuleViolation | null {
  if (input.target.role === input.newRole) return null;
  if (!canManageMember(input.actor, input.target) || !canAssignRole(input.actor, input.newRole)) {
    return { code: "forbidden", message: "Só o proprietário pode promover a proprietário ou mudar o papel de um administrador." };
  }
  if (input.target.role === "owner" && input.activeOwnerCount <= 1) {
    return { code: "last_owner", message: "A empresa precisa de pelo menos um proprietário." };
  }
  return null;
}

/** Inativar alguém: nunca a si mesmo, só quem o papel permite, e nunca o último proprietário ativo. */
export function checkDeactivate(input: {
  actor: MemberRole;
  actorId: string;
  target: Person;
  activeOwnerCount: number;
}): RuleViolation | null {
  if (input.target.id === input.actorId) return { code: "self", message: "Você não pode inativar a sua própria conta." };
  if (!canManageMember(input.actor, input.target)) {
    return { code: "forbidden", message: "Só o proprietário pode inativar ou reativar proprietários e administradores." };
  }
  if (input.target.role === "owner" && input.activeOwnerCount <= 1) {
    return { code: "last_owner", message: "A empresa precisa de pelo menos um proprietário ativo." };
  }
  return null;
}

/** Reativar: mesma regra de quem pode mexer na pessoa (e nunca a si mesmo, que nem consegue entrar). */
export function checkReactivate(input: { actor: MemberRole; actorId: string; target: Person }): RuleViolation | null {
  if (input.target.id === input.actorId) return { code: "self", message: "Você não pode inativar a sua própria conta." };
  if (!canManageMember(input.actor, input.target)) {
    return { code: "forbidden", message: "Só o proprietário pode inativar ou reativar proprietários e administradores." };
  }
  return null;
}

/** O limite de usuários conta ativos + convites pendentes; `max = null` é ilimitado. */
export function isOverUserLimit(used: number, max: number | null) {
  return max !== null && used >= max;
}
