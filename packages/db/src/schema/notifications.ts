import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizationId, tenantPolicy } from "./_tenant";

// Ids de linha: UUID v7 gerado pela aplicação (o pacote db não depende de `uuid`; veja platform.ts).

/**
 * Notificações do sino. Uma linha por pessoa que deve ficar sabendo (`userId` = o mesmo id de `member.userId` e
 * `team_members.memberRef`); só a própria pessoa lê e marca como lida (a API filtra por `userId`; o RLS isola a empresa).
 * Sem FK para o usuário: a limpeza de lidas antigas (60 dias) já mantém a tabela pequena.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    userId: text().notNull(),
    /** 'appointment_booked' | 'appointment_rescheduled' | 'appointment_canceled' (contrato: packages/contracts/src/notifications.ts) */
    kind: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    /** Rota do app a abrir ao clicar; null = não leva a lugar nenhum. */
    link: text(),
    readAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // lista da pessoa (mais novas primeiro)
    index("notifications_org_user_created_idx").on(t.organizationId, t.userId, t.createdAt.desc()),
    // contagem de não lidas: só as não lidas entram no índice
    index("notifications_org_user_unread_idx").on(t.organizationId, t.userId).where(sql`${t.readAt} is null`),
    // limpeza das lidas antigas da empresa
    index("notifications_org_read_at_idx").on(t.organizationId, t.readAt).where(sql`${t.readAt} is not null`),
    tenantPolicy("notifications", t.organizationId),
  ],
).enableRLS();
