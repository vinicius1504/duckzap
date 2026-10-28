import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { invitation, user } from "./auth";
import { organizationId, tenantPolicy } from "./_tenant";

// Ids de linha: UUID v7 gerado pela aplicação (o pacote db não depende de `uuid`; veja platform.ts).

/**
 * Dados da pessoa DENTRO de uma empresa. `member` (Better Auth) guarda só o papel; o resto vive aqui.
 * Sem linha = ativa (a linha é criada na primeira vez que algo precisa ser gravado).
 * Dado de produto, por isso tem RLS (diferente de `member`/`invitation`, que são do Better Auth).
 */
export const memberProfiles = pgTable(
  "member_profiles",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** false = inativa: não entra, não conta no limite do plano. */
    active: boolean().notNull().default(true),
    deactivatedAt: timestamp({ withTimezone: true }),
    /** Telefone como a pessoa digitou (E.164 quando possível); null até preencher. */
    phone: text(),
    twoFactorEnabledAt: timestamp({ withTimezone: true }),
    /** { sound, browser, emailSummary } */
    notifications: jsonb()
      .$type<{ sound: boolean; browser: boolean; emailSummary: boolean }>()
      .notNull()
      .default(sql`'{"sound":true,"browser":true,"emailSummary":false}'::jsonb`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("member_profiles_org_user_unique").on(t.organizationId, t.userId),
    index("member_profiles_organization_id_idx").on(t.organizationId),
    tenantPolicy("member_profiles", t.organizationId),
  ],
).enableRLS();

/** Nome de um convite pendente (o `invitation` do Better Auth só guarda e-mail e papel). */
export const inviteProfiles = pgTable(
  "invite_profiles",
  {
    invitationId: text()
      .primaryKey()
      .references(() => invitation.id, { onDelete: "cascade" }),
    organizationId: organizationId(),
    name: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invite_profiles_organization_id_idx").on(t.organizationId), tenantPolicy("invite_profiles", t.organizationId)],
).enableRLS();

/** Equipes de atendimento (setores). Os canais da equipe são os que têm `channels.team_id` = esta equipe. */
export const teams = pgTable(
  "teams",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    name: text().notNull(),
    color: text().notNull(),
    /** 1 = recebe primeiro quando a conversa não tem equipe definida. */
    priority: integer().notNull(),
    /** BusinessHours do contrato (7 dias). */
    businessHours: jsonb().notNull(),
    greeting: text().notNull().default(""),
    outOfHoursMessage: text().notNull().default(""),
    // Canais e agente da equipe NÃO são guardados aqui: a fonte de verdade é `channels.team_id`/`channels.agent_id`.
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("teams_organization_id_idx").on(t.organizationId),
    // o contrato do front usa nomes de cor (a tela mapeia para um token), não hex
    check("teams_color_check", sql`${t.color} in ('yellow','slate','green','blue','orange','red')`),
    tenantPolicy("teams", t.organizationId),
  ],
).enableRLS();

/**
 * Quem está em cada equipe. `memberRef` é o id do usuário (pessoa ativa) ou o id do convite
 * (pessoa convidada); ao aceitar o convite a referência troca para o id do usuário.
 */
export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    organizationId: organizationId(),
    memberRef: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("team_members_team_ref_unique").on(t.teamId, t.memberRef),
    index("team_members_organization_id_idx").on(t.organizationId),
    index("team_members_member_ref_idx").on(t.memberRef),
    tenantPolicy("team_members", t.organizationId),
  ],
).enableRLS();
