import type { MemberRole } from "./session";

/**
 * Matriz de permissões (RBAC, §5.1). Fonte única: o front usa para esconder ou desabilitar,
 * a API usa para autorizar de verdade. Esconder botão não é autorização.
 */
export const permissions = [
  "home.view_team_metrics",
  "conversation.reply",
  "conversation.assign",
  "conversation.transfer",
  "conversation.view_all",
  "contact.edit",
  "contact.import",
  "contact.export",
  "contact.delete",
  "contact.bulk",
  "appointment.manage",
  "catalog.manage",
  "campaign.manage",
  "campaign.send",
  "agent.manage",
  "channel.manage",
  "team.manage",
  "settings.manage",
  "integration.manage",
  "billing.manage",
] as const;

export type Permission = (typeof permissions)[number];

const agentPermissions: readonly Permission[] = [
  "conversation.reply",
  "conversation.assign",
  "conversation.transfer",
  "contact.edit",
  "appointment.manage",
];

const adminPermissions: readonly Permission[] = permissions.filter((p) => p !== "billing.manage");

const matrix: Record<MemberRole, ReadonlySet<Permission>> = {
  owner: new Set(permissions),
  admin: new Set(adminPermissions),
  agent: new Set(agentPermissions),
};

export function can(role: MemberRole, permission: Permission) {
  return matrix[role].has(permission);
}

export const roleLabels: Record<MemberRole, string> = {
  owner: "Proprietário",
  admin: "Administrador",
  agent: "Atendente",
};
