import type { MemberRole } from "@duckzap/contracts/session";

/**
 * Regras de papel da Equipe (§5.1), usadas pela tela (esconder/desabilitar) e pelo mock da API.
 * O back repete as mesmas regras: esconder botão não é autorização.
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

/** 2FA obrigatório para Proprietário e Administrador. */
export const requiresTwoFactor = (role: MemberRole) => role === "owner" || role === "admin";
