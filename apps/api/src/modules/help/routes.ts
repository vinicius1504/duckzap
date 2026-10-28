import { askAssistantInputSchema, supportTicketInputSchema } from "@duckzap/contracts/help";
import { OpenAPIHono } from "@hono/zod-openapi";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { AppBindings, Deps } from "../../lib/context";
import { createMailer, type Mail } from "../../lib/mailer";
import { ApiError, jsonLimit, moduleErrorHandler, parseWith, readJson, requestCtx, tenantGuard } from "../contacts/http";
import { createRateLimiter } from "./rate-limit";
import { askAssistant, getHelpCenter, newProtocol, singleLine } from "./service";

const queryParam = z.string().trim().max(100).catch("");

type HelpOptions = { sendMail?: (mail: Mail) => Promise<void> };

/**
 *   GET  /v1/help?q=             FAQ (filtrada), vídeos e dados de suporte (conteúdo versionado em content.ts)
 *   POST /v1/help/ask            assistente: IA (tier fast) com a ajuda como contexto; sem IA, palavras-chave
 *   POST /v1/support/tickets     chamado: sai por e-mail para SUPPORT_EMAIL (sem tabela nesta fase) e devolve o protocolo
 *   POST /v1/me/tour/restart     reinicia o tour (hoje só registra: o estado do tour ainda é do navegador)
 * Qualquer pessoa da equipe usa; o `organizationId` vem sempre da sessão.
 */
export function helpRoutes(deps: Deps, options: HelpOptions = {}) {
  const app = new OpenAPIHono<AppBindings>();
  app.onError(moduleErrorHandler);
  const guard = tenantGuard(deps);
  const sendMail = options.sendMail ?? createMailer(deps.env);
  // cada pergunta pode gastar tokens e cada chamado gera e-mail: limite por pessoa
  const askLimit = createRateLimiter(12, 60_000);
  const ticketLimit = createRateLimiter(5, 60 * 60_000);

  app.get("/help", guard, (c) => c.json(getHelpCenter(parseWith(queryParam, c.req.query("q") ?? ""))));

  app.post("/help/ask", guard, jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, askAssistantInputSchema);
    if (!askLimit.take(ctx.userId)) throw new ApiError(429, "rate_limited", "Muitas perguntas seguidas. Aguarde um minuto e tente de novo.");
    return c.json(await askAssistant(deps.llm, { question: body.question, organizationId: ctx.organizationId }));
  });

  app.post("/support/tickets", guard, jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, supportTicketInputSchema);
    if (!ticketLimit.take(ctx.userId)) throw new ApiError(429, "rate_limited", "Você já enviou vários chamados. Aguarde um pouco ou fale com o suporte pelo WhatsApp.");
    const protocol = newProtocol();
    const id = uuidv7();
    const to = deps.env.SUPPORT_EMAIL?.trim();
    if (to) {
      try {
        await sendMail({
          to,
          subject: `[DuckChat ${protocol}] ${singleLine(body.subject)}`.slice(0, 200),
          text: [
            `Protocolo: ${protocol}`,
            `Empresa: ${ctx.orgName} (${ctx.organizationId})`,
            `Pessoa: ${ctx.userName} <${ctx.session.user.email}>`,
            "",
            body.message,
          ].join("\n"),
        });
      } catch (error) {
        console.error({ requestId: c.get("requestId"), msg: "support ticket mail failed", protocol, err: error instanceof Error ? error.message : "erro" });
        throw new ApiError(502, "support_unavailable", "Não conseguimos enviar seu chamado agora. Tente de novo em instantes.");
      }
    } else {
      // sem SUPPORT_EMAIL (dev): registra só o protocolo, nunca o texto
      console.info({ msg: "support ticket (SUPPORT_EMAIL não definido)", protocol, organizationId: ctx.organizationId });
    }
    return c.json({ id, protocol }, 201);
  });

  app.post("/me/tour/restart", guard, (c) => {
    const ctx = requestCtx(c);
    console.info({ msg: "tour restart", organizationId: ctx.organizationId, userId: ctx.userId });
    return c.json({ ok: true });
  });

  return app;
}
