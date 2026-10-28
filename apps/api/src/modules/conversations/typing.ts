import { can } from "@duckzap/contracts/permissions";
import { schema, withOrg, type Database } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppBindings, Deps } from "../../lib/context";
import { MAX_PRESENCE_MS, type ChannelRef, type MessagingProvider } from "../../lib/messaging";
import { findSendChannel, buildRef } from "../channels/repo";
import { getChannelsRuntime, type ChannelsRuntime } from "../channels/runtime";
import { isSendingPausedForOrg } from "../channels/sending";
import { ApiError, idParam, moduleErrorHandler, permit, requestCtx, tenantGuard } from "./http";
import { findVisibleConversation, type ConvCtx } from "./queries";

/**
 * Quanto o "digitando…" do atendente dura no WhatsApp do cliente a cada chamada. A Evolution mantém `composing` por `delay` ms
 * e então envia `paused` sozinha; a tela renova a cada ~4 s. A duração fica ABAIXO do intervalo de renovação de propósito:
 * se fosse maior, o `paused` da chamada anterior chegaria depois do `composing` da seguinte e apagaria o aviso (pior que um
 * respiro de 0,5 s entre uma e outra).
 */
export const ATTENDANT_TYPING_MS = 3_500;
/** No máximo uma chamada ao provedor por conversa neste intervalo (a tela renova a cada 4 s; a folga absorve oscilação de rede). */
export const ATTENDANT_TYPING_MIN_INTERVAL_MS = 3_500;

/**
 * Porta do limitador do "digitando…" do atendente. Hoje em memória (por processo); com vários processos, implementar
 * esta mesma interface sobre Redis (`SET key 1 NX PX <intervalo>`: devolve true só para quem criou a chave).
 */
export interface TypingThrottle {
  /** true = pode chamar o provedor agora; false = chamada recente, descarte. */
  allow(key: string): Promise<boolean>;
}

export class InMemoryTypingThrottle implements TypingThrottle {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly options: { minIntervalMs?: number; maxKeys?: number; now?: () => number } = {},
  ) {}

  async allow(key: string): Promise<boolean> {
    const now = (this.options.now ?? Date.now)();
    const minInterval = this.options.minIntervalMs ?? ATTENDANT_TYPING_MIN_INTERVAL_MS;
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < minInterval) return false;
    this.last.delete(key); // reinserir mantém a ordem de uso (limpeza do mais antigo)
    this.last.set(key, now);
    const maxKeys = this.options.maxKeys ?? 10_000;
    while (this.last.size > maxKeys) {
      const oldest = this.last.keys().next();
      if (oldest.done) break;
      this.last.delete(oldest.value);
    }
    return true;
  }
}

export type TypingDeps = {
  db: Database;
  channels: Pick<ChannelsRuntime, "providers" | "config" | "now" | "log" | "background">;
  throttle: TypingThrottle;
};

export type TypingTarget = { provider: MessagingProvider; ref: ChannelRef; to: string };

/** Conversa em que a IA responde sozinha (ou já encerrada): o atendente não "digita" ali. */
export function humanMayType(conv: { mode: string; status: string }): boolean {
  if (conv.status === "resolved") return false;
  return !(conv.mode === "ai" && conv.status === "ai_active");
}

/**
 * Resolve, DENTRO da empresa do atendente, para onde mandar o "digitando…". Devolve `"not_found"` (404: conversa de outra
 * empresa, invisível para esta pessoa ou inexistente) ou `null` quando não há o que fazer (IA respondendo, conversa
 * encerrada, plano suspenso, canal sem a capacidade, contato sem telefone): o chamador responde 204 do mesmo jeito.
 */
export async function resolveTypingTarget(deps: TypingDeps, ctx: ConvCtx, conversationId: string): Promise<TypingTarget | "not_found" | null> {
  return withOrg(deps.db, ctx.organizationId, async (tx) => {
    const conv = await findVisibleConversation(tx, ctx, conversationId);
    if (!conv) return "not_found" as const;
    if (!humanMayType(conv)) return null;
    if (await isSendingPausedForOrg(tx, deps.channels.now())) return null;

    const channel = await findSendChannel(tx, ctx.organizationId, conv.channelId);
    if (!channel || channel.status !== "connected" || channel.type !== "whatsapp_qr") return null;
    const provider = deps.channels.providers.get(channel.provider);
    if (!provider?.sendPresence || !provider.capabilities().presence) return null;

    const [contact] = await tx.select({ phone: schema.contacts.phone }).from(schema.contacts).where(eq(schema.contacts.id, conv.contactId)).limit(1);
    if (!contact?.phone) return null;
    return { provider, ref: buildRef(channel, deps.channels), to: contact.phone };
  });
}

/**
 * "Atendente digitando…" → presença `composing` no WhatsApp do cliente. Melhor esforço: o limitador vem DEPOIS das checagens
 * (chamada recusada não gasta cota), a chamada ao provedor segura a conexão pelo tempo do `delay`, por isso roda em segundo
 * plano, e nenhuma falha dela chega ao atendente.
 */
export async function sendAttendantTyping(deps: TypingDeps, ctx: ConvCtx, conversationId: string): Promise<"not_found" | "sent" | "skipped"> {
  const target = await resolveTypingTarget(deps, ctx, conversationId);
  if (target === "not_found") return "not_found";
  if (!target) return "skipped";
  if (!(await deps.throttle.allow(`${ctx.organizationId}:${conversationId}`))) return "skipped";
  const { provider, ref, to } = target;
  deps.channels.background(async () => {
    try {
      await provider.sendPresence?.(ref, { to, presence: "composing", durationMs: Math.min(ATTENDANT_TYPING_MS, MAX_PRESENCE_MS) });
    } catch (error) {
      // sem telefone, sem token: só o tipo do erro
      deps.channels.log.warn("conversations.typing.failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  });
  return "sent";
}

export type TypingRoutesOverrides = { channels?: TypingDeps["channels"]; throttle?: TypingThrottle };

/**
 * POST /v1/conversations/:id/typing   conversation.reply   204 sempre que a conversa é alcançável (404 se não); sem corpo.
 * Rota própria (montada junto das demais em modules/index.ts) para não crescer o routes.ts do inbox.
 */
export function conversationTypingRoutes(deps: Deps, overrides: TypingRoutesOverrides = {}) {
  const app = new OpenAPIHono<AppBindings>();
  app.onError(moduleErrorHandler);
  const guard = tenantGuard(deps);
  const throttle = overrides.throttle ?? new InMemoryTypingThrottle();

  app.post("/conversations/:id/typing", guard, permit("conversation.reply"), async (c) => {
    const id = idParam(c);
    const ctx = requestCtx(c);
    const convCtx: ConvCtx = {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      userName: ctx.userName,
      timeZone: ctx.timeZone,
      orgName: ctx.orgName,
      canViewAll: can(ctx.role, "conversation.view_all"),
      sendingPaused: ctx.sendingPaused,
    };
    let outcome: Awaited<ReturnType<typeof sendAttendantTyping>> = "skipped";
    try {
      outcome = await sendAttendantTyping({ db: deps.db, channels: overrides.channels ?? getChannelsRuntime(), throttle }, convCtx, id);
    } catch {
      // presença é enfeite: erro interno vira "nada aconteceu"
    }
    if (outcome === "not_found") throw new ApiError(404, "not_found", "Conversa não encontrada.");
    return c.body(null, 204);
  });

  return app;
}
