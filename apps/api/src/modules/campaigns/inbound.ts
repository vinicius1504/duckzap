import { schema, withOrg } from "@duckzap/db";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { registerInboundHandler, type InboundContext } from "../../lib/inbound";
import { isExplicitOptOut } from "../contacts/consent";
import { findContactByPhone, registerOptOut } from "../contacts/service";
import type { CampaignsRuntime } from "./ports";

const { campaigns, campaignRecipients } = schema;

// Respostas a campanhas (§5.7 itens 5 e 6), SEM depender do módulo Conversas:
//  - quem responde sai da campanha (os envios pendentes dele viram `skipped`) e o envio já feito vira `replied`;
//  - "SAIR/PARAR…" de quem recebeu (ou ia receber) uma campanha vira opt-out PERMANENTE (`registerOptOut` do módulo Clientes)
//    e conta para o disjuntor (3+ nas últimas 20 pausa a campanha);
//  - eventos de status do provedor (entregue/lida/falhou) atualizam o registro do envio pelo id da mensagem.
// O handler é registrado UMA vez por processo; a instância de runtime usada é sempre a mais recente.

const REPLY_WINDOW_DAYS = 30;

export async function handleInboundForCampaigns(rt: CampaignsRuntime, context: InboundContext, now: Date = rt.now()): Promise<void> {
  const { organizationId, event } = context;
  if (event.type === "status") {
    await withOrg(rt.db, organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(campaignRecipients)
        .where(and(eq(campaignRecipients.organizationId, organizationId), eq(campaignRecipients.providerMessageId, event.externalId)))
        .limit(1);
      if (!row) return;
      const at = new Date(event.at);
      if (event.status === "delivered" && row.status === "sent") {
        await tx.update(campaignRecipients).set({ status: "delivered", deliveredAt: row.deliveredAt ?? at, updatedAt: now }).where(eq(campaignRecipients.id, row.id));
      } else if (event.status === "read" && (row.status === "sent" || row.status === "delivered")) {
        await tx.update(campaignRecipients).set({ status: "read", deliveredAt: row.deliveredAt ?? at, readAt: row.readAt ?? at, updatedAt: now }).where(eq(campaignRecipients.id, row.id));
      } else if (event.status === "failed" && row.status === "sent") {
        await tx.update(campaignRecipients).set({ status: "failed", errorCode: "provider_failed", reason: "O provedor informou falha na entrega", updatedAt: now }).where(eq(campaignRecipients.id, row.id));
      }
    });
    return;
  }
  // mensagem que saiu da nossa conta (eco ou digitada no celular) não é resposta do cliente: "SAIR" escrito pela equipe não descadastra ninguém
  if (event.type !== "message" || event.fromMe) return;

  await withOrg(rt.db, organizationId, async (tx) => {
    const contact = await findContactByPhone(tx, organizationId, event.from);
    if (!contact) return;
    const since = new Date(now.getTime() - REPLY_WINDOW_DAYS * 86_400_000);
    const sent = await tx
      .select()
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.organizationId, organizationId),
          eq(campaignRecipients.contactId, contact.id),
          inArray(campaignRecipients.status, ["sent", "delivered", "read", "replied"]),
          gte(campaignRecipients.sentAt, since),
        ),
      )
      .orderBy(desc(campaignRecipients.sentAt));
    const queued = await tx
      .select({ id: campaignRecipients.id })
      .from(campaignRecipients)
      .innerJoin(campaigns, eq(campaigns.id, campaignRecipients.campaignId))
      .where(
        and(
          eq(campaignRecipients.organizationId, organizationId),
          eq(campaignRecipients.contactId, contact.id),
          eq(campaignRecipients.status, "queued"),
          isNull(campaignRecipients.attemptedAt),
          inArray(campaigns.status, ["scheduled", "sending", "paused"]),
        ),
      );
    if (sent.length === 0 && queued.length === 0) return;

    const at = new Date(event.at);
    const text = event.kind === "text" ? (event.text ?? "") : "";
    const [latest] = sent;
    if (text && isExplicitOptOut(text)) {
      // bloqueio permanente: vale para TODAS as campanhas e convites (consents.status = denied)
      await registerOptOut(tx, organizationId, contact.id, text, now);
      if (latest) {
        await tx
          .update(campaignRecipients)
          .set({ status: "opted_out", optedOutAt: now, repliedAt: latest.repliedAt ?? at, reason: "Pediu para sair", updatedAt: now })
          .where(eq(campaignRecipients.id, latest.id));
      }
      if (queued.length) {
        await tx
          .update(campaignRecipients)
          .set({ status: "opted_out", optedOutAt: now, reason: "Pediu para sair antes do envio", updatedAt: now })
          .where(inArray(campaignRecipients.id, queued.map((q) => q.id)));
      }
      return;
    }

    if (latest && latest.status !== "replied") {
      await tx
        .update(campaignRecipients)
        .set({ status: "replied", repliedAt: at, deliveredAt: latest.deliveredAt ?? at, updatedAt: now })
        .where(eq(campaignRecipients.id, latest.id));
    }
    if (queued.length) {
      // respondeu antes de chegar a vez: sai da campanha e vira conversa normal (agente ou equipe)
      await tx
        .update(campaignRecipients)
        .set({ status: "skipped", reason: "Respondeu antes do envio: virou conversa normal", updatedAt: now })
        .where(inArray(campaignRecipients.id, queued.map((q) => q.id)));
    }
  });
}

let registered = false;
let current: CampaignsRuntime | null = null;

/** Registra o handler uma única vez por processo (rotas podem ser montadas várias vezes em testes). */
export function ensureCampaignInboundHandler(rt: CampaignsRuntime) {
  current = rt;
  if (registered) return;
  registered = true;
  registerInboundHandler(async (context) => {
    if (current) await handleInboundForCampaigns(current, context);
  });
}
