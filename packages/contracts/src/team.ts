import { z } from "zod";
import { memberRoleSchema } from "./session";
import { businessHoursSchema } from "./settings";

export const memberStatusSchema = z.enum(["active", "invited", "inactive"]);
export type MemberStatus = z.infer<typeof memberStatusSchema>;

export const memberSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  /** E.164; null até a pessoa completar o cadastro. */
  phone: z.string().nullable(),
  role: memberRoleSchema,
  status: memberStatusSchema,
  teamIds: z.array(z.string()),
  twoFactorEnabled: z.boolean(),
  invitedAt: z.iso.datetime().nullable(),
  lastActiveAt: z.iso.datetime().nullable(),
});
export type Member = z.infer<typeof memberSchema>;

/** Cor escolhida para a equipe (a tela mapeia para um token). */
export const teamColorSchema = z.enum(["yellow", "slate", "green", "blue", "orange", "red"]);
export type TeamColor = z.infer<typeof teamColorSchema>;

export const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Leitura tolerante: cor desconhecida (dado antigo) cai em "slate" em vez de derrubar a tela de Equipe. */
  color: teamColorSchema.catch("slate"),
  /** 1 = recebe primeiro quando a conversa não tem equipe definida. */
  priority: z.number().int().min(1),
  businessHours: businessHoursSchema,
  greeting: z.string(),
  outOfHoursMessage: z.string(),
  memberIds: z.array(z.string()),
  channelIds: z.array(z.string()),
  agentId: z.string().nullable(),
});
export type Team = z.infer<typeof teamSchema>;

export const teamOverviewSchema = z.object({
  members: z.array(memberSchema),
  teams: z.array(teamSchema),
  channels: z.array(z.object({ id: z.string(), name: z.string() })),
  agents: z.array(z.object({ id: z.string(), name: z.string() })),
  /** Ativos + convites pendentes contam; inativos não. */
  userLimit: z.object({ used: z.number().int(), max: z.number().int().nullable() }),
});
export type TeamOverview = z.infer<typeof teamOverviewSchema>;

export const inviteMemberInputSchema = z.object({
  name: z.string().trim().min(2, "Informe o nome.").max(80),
  email: z.email("E-mail inválido."),
  role: memberRoleSchema,
  teamIds: z.array(z.string()),
});
export type InviteMemberInput = z.infer<typeof inviteMemberInputSchema>;

export const updateMemberInputSchema = z.object({
  name: z.string().trim().min(2, "Informe o nome.").max(80),
  role: memberRoleSchema,
  teamIds: z.array(z.string()),
});
export type UpdateMemberInput = z.infer<typeof updateMemberInputSchema>;

export const teamInputSchema = z.object({
  name: z.string().trim().min(2, "Informe o nome da equipe.").max(40),
  color: teamColorSchema,
  priority: z.number().int().min(1).max(20),
  businessHours: businessHoursSchema,
  /**
   * Legado, hoje sem efeito: nenhum envio ao cliente usa estes textos da equipe (só os do canal, e só no modo "Automático").
   * Opcionais: ausente = vazio ao criar e mantém o valor guardado ao editar. A tela de Equipe não os pede mais.
   */
  greeting: z.string().trim().max(500).optional(),
  outOfHoursMessage: z.string().trim().max(500).optional(),
  memberIds: z.array(z.string()),
  channelIds: z.array(z.string()),
  agentId: z.string().nullable(),
});
export type TeamInput = z.infer<typeof teamInputSchema>;
