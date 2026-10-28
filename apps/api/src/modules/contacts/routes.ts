import {
  contactInputSchema,
  contactListInputSchema,
  contactListQuerySchema,
  exportRequestSchema,
  importCommitSchema,
  inviteRequestSchema,
  tagInputSchema,
  whatsappImportCommitSchema,
  whatsappImportStartSchema,
  WHATSAPP_IMPORT_MAX_ROWS,
} from "@duckzap/contracts/contacts";
import { withOrg } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { AppBindings, Deps } from "../../lib/context";
import { InMemoryTokenBucket, type RateLimiter } from "../channels/rate-limit";
import { getChannelsRuntime } from "../channels/runtime";
import { MAX_IMPORT_BYTES } from "./csv";
import {
  ApiError,
  idParam,
  jsonLimit,
  moduleErrorHandler,
  parseWith,
  permit,
  requestCtx,
  readJson,
  tenantGuard,
  unwrap,
  uploadLimit,
  type ModuleContext,
} from "./http";
import { commitImport, exportContacts, previewImport } from "./import-export";
import { inviteOverview, sendInvites } from "./invites";
import { createInMemoryPorts, type ContactsPorts } from "./ports";
import * as service from "./service";
import { commitWhatsappImport, previewWhatsappImport, type WhatsappImportDeps } from "./whatsapp-import";

const guidList = z.array(z.guid()).min(1, "Selecione ao menos um cliente.").max(5000);
const noteSchema = z.object({ text: z.string().trim().min(1, "Escreva a nota antes de salvar.").max(2000) });
const bulkTagSchema = z.object({ contactIds: guidList, tagId: z.guid() });
const bulkListSchema = z.object({ contactIds: guidList, listId: z.guid() });
const bulkDeleteSchema = z.object({ contactIds: guidList });
const uploadSchema = z.object({ fileName: z.string().trim().min(1, "Escolha uma planilha (.csv).").max(200), contentBase64: z.string().max(15 * 1024 * 1024) });
// Ids que o contrato declara como texto: na API precisam ser UUID (id malformado seria erro de SQL, 500)
const contactBodySchema = contactInputSchema.safeExtend({ tagIds: z.array(z.guid()).max(50), ownerId: z.string().min(1).max(100).nullable() });
const exportBodySchema = exportRequestSchema.safeExtend({
  contactIds: guidList.nullable(),
  filter: exportRequestSchema.shape.filter.unwrap().safeExtend({ tagId: z.guid().optional() }).nullable(),
});
const commitBodySchema = importCommitSchema.extend({ importId: z.guid(), tagIds: z.array(z.guid()).max(50), listId: z.guid().nullable() });
const whatsappStartBodySchema = whatsappImportStartSchema.extend({ channelId: z.string().trim().min(1).max(100) });
const whatsappCommitBodySchema = whatsappImportCommitSchema.extend({
  importId: z.guid(),
  rows: z
    .array(z.object({ phone: z.string().trim().min(1).max(32), name: z.string().trim().max(120) }))
    .min(1, "Marque ao menos um contato.")
    .max(WHATSAPP_IMPORT_MAX_ROWS),
  tagIds: z.array(z.guid()).max(50),
  listId: z.guid().nullable(),
});
/** Buscar contatos no WhatsApp é uma chamada pesada ao provedor: poucas por minuto, por empresa. */
export const WHATSAPP_PREVIEWS_PER_MINUTE = 6;
const reorderSchema = z.object({ orderedIds: z.array(z.guid()).max(200) });

/** A query chega como texto: converte o que é número/booleano e valida com o schema do contrato. */
export function parseListQuery(raw: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === "") continue;
    if (["createdWithinDays", "inactiveDays", "birthMonth", "page", "pageSize"].includes(key)) out[key] = Number(value);
    else if (key === "isCustomer") out[key] = value === "true" ? true : value === "false" ? false : value;
    else out[key] = value;
  }
  return parseWith(contactListQuerySchema.safeExtend({ tagId: z.guid().optional(), listId: z.guid().optional() }), { page: 1, pageSize: 25, ...out });
}

/** CSV de planilha do Excel costuma vir em Windows-1252: tenta UTF-8 estrito e cai para ele. */
export function decodeSpreadsheet(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export type ContactsRouteOptions = {
  /** Provedores de WhatsApp (padrão: o runtime de Canais, lido a cada pedido). Testes injetam um provedor falso. */
  whatsapp?: () => WhatsappImportDeps;
  whatsappPreviewLimiter?: RateLimiter;
};

export function contactsRoutes(deps: Deps, ports: ContactsPorts = createInMemoryPorts().ports, options: ContactsRouteOptions = {}) {
  const app = new OpenAPIHono<AppBindings>();
  app.onError(moduleErrorHandler);
  const guard = tenantGuard(deps);
  const whatsappDeps = options.whatsapp ?? (() => getChannelsRuntime());
  const whatsappPreviewLimiter =
    options.whatsappPreviewLimiter ?? new InMemoryTokenBucket({ capacity: WHATSAPP_PREVIEWS_PER_MINUTE, refillPerSecond: WHATSAPP_PREVIEWS_PER_MINUTE / 60 });
  const run = <T>(c: ModuleContext, fn: Parameters<typeof withOrg<T>>[2]) => withOrg(deps.db, requestCtx(c).organizationId, fn);

  // Leitura: qualquer pessoa da equipe (a matriz não tem permissão de visualização). -----------------------------
  app.get("/contacts", guard, async (c) => {
    const query = parseListQuery(c.req.query());
    const ctx = requestCtx(c);
    return c.json(await run(c, (tx) => service.listContacts(tx, ctx, query)));
  });

  app.get("/contacts/options", guard, async (c) => {
    const ctx = requestCtx(c);
    return c.json(await run(c, (tx) => service.listContactOptions(tx, ctx)));
  });

  app.get("/contacts/owners", guard, async (c) => {
    const ctx = requestCtx(c);
    return c.json(await run(c, (tx) => service.listOrgOwners(tx, ctx.organizationId)));
  });

  // Convite de consentimento -------------------------------------------------------------------------------------
  // A visão geral é leitura (as telas de Clientes a carregam para qualquer papel); enviar exige campaign.send.
  app.get("/contacts/invites/overview", guard, async (c) => {
    return c.json(await inviteOverview(deps.db, requestCtx(c), ports));
  });

  app.post("/contacts/invites", guard, permit("campaign.send"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    // plano expirado: leitura liberada, envio bloqueado no servidor
    if (ctx.sendingPaused) throw new ApiError(403, "sending_paused", "Seu plano expirou. O envio está pausado até a renovação.");
    const body = await readJson(c, inviteRequestSchema.extend({ contactIds: guidList, channelId: z.string().min(1).max(100) }));
    return c.json(unwrap(await sendInvites(deps.db, ctx, ports, body)));
  });

  // Importar / exportar ------------------------------------------------------------------------------------------
  // O arquivo vai em JSON (base64): o `apiFetch` do front é JSON-only e a planilha tem no máximo 10 MB.
  app.post("/contacts/import/preview", guard, permit("contact.import"), uploadLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, uploadSchema);
    const bytes = Buffer.from(body.contentBase64, "base64");
    if (bytes.byteLength > MAX_IMPORT_BYTES) throw new ApiError(413, "too_large", "O arquivo passa de 10 MB. Divida em partes menores.");
    const text = decodeSpreadsheet(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return c.json(unwrap(await run(c, (tx) => previewImport(tx, ctx, { name: body.fileName, size: bytes.byteLength, text }))));
  });

  app.post("/contacts/import/commit", guard, permit("contact.import"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, commitBodySchema);
    return c.json(unwrap(await run(c, (tx) => commitImport(tx, ctx, body))));
  });

  // Importar do WhatsApp: mesma sequência da planilha (prévia → confirmação), com a lista vinda do WhatsApp do canal.
  app.post("/contacts/import/whatsapp/preview", guard, permit("contact.import"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, whatsappStartBodySchema);
    const taken = await whatsappPreviewLimiter.take(ctx.organizationId);
    if (!taken.allowed) {
      throw new ApiError(429, "rate_limited", "Você buscou contatos muitas vezes seguidas. Aguarde um minuto e tente de novo.", {
        retryAfterSeconds: Math.ceil(taken.retryAfterMs / 1000),
      });
    }
    return c.json(unwrap(await previewWhatsappImport((fn) => run(c, fn), ctx, body, whatsappDeps())));
  });

  app.post("/contacts/import/whatsapp/commit", guard, permit("contact.import"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, whatsappCommitBodySchema);
    return c.json(unwrap(await run(c, (tx) => commitWhatsappImport(tx, ctx, body))));
  });

  app.post("/contacts/export", guard, permit("contact.export"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, exportBodySchema);
    return c.json(await run(c, (tx) => exportContacts(tx, ctx, body)));
  });

  // Ações em massa -----------------------------------------------------------------------------------------------
  app.post("/contacts/bulk/tag", guard, permit("contact.bulk"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, bulkTagSchema);
    return c.json(unwrap(await run(c, (tx) => service.tagContacts(tx, ctx, body.contactIds, body.tagId))));
  });

  app.post("/contacts/bulk/list", guard, permit("contact.bulk"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, bulkListSchema);
    return c.json(unwrap(await run(c, (tx) => service.addContactsToList(tx, ctx, body.contactIds, body.listId))));
  });

  // Exclusão do titular (LGPD): permissão própria, mais restrita que a edição.
  app.post("/contacts/bulk/delete", guard, permit("contact.delete"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, bulkDeleteSchema);
    return c.json(unwrap(await run(c, (tx) => service.deleteContacts(tx, ctx, body.contactIds))));
  });

  // Contato ------------------------------------------------------------------------------------------------------
  app.post("/contacts", guard, permit("contact.edit"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, contactBodySchema);
    return c.json(unwrap(await run(c, (tx) => service.createContact(tx, ctx, body))), 201);
  });

  app.get("/contacts/:id", guard, async (c) => {
    const id = idParam(c);
    const ctx = requestCtx(c);
    const detail = await run(c, (tx) => service.getContact(tx, ctx, id));
    if (!detail) throw new ApiError(404, "not_found", "Cliente não encontrado.");
    return c.json(detail);
  });

  app.patch("/contacts/:id", guard, permit("contact.edit"), jsonLimit, async (c) => {
    const id = idParam(c);
    const ctx = requestCtx(c);
    const body = await readJson(c, contactBodySchema);
    return c.json(unwrap(await run(c, (tx) => service.updateContact(tx, ctx, id, body))));
  });

  app.post("/contacts/:id/notes", guard, permit("contact.edit"), jsonLimit, async (c) => {
    const id = idParam(c);
    const ctx = requestCtx(c);
    const body = await readJson(c, noteSchema);
    return c.json(unwrap(await run(c, (tx) => service.addContactNote(tx, ctx, id, body.text))), 201);
  });

  // Etiquetas (a matriz não tem permissão própria: usa contact.bulk, como o front) --------------------------------
  app.get("/tags", guard, async (c) => {
    const ctx = requestCtx(c);
    return c.json(await run(c, (tx) => service.listTags(tx, ctx)));
  });

  app.post("/tags", guard, permit("contact.bulk"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, tagInputSchema);
    return c.json(unwrap(await run(c, (tx) => service.createTag(tx, ctx, body))), 201);
  });

  app.put("/tags/order", guard, permit("contact.bulk"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, reorderSchema);
    unwrap(await run(c, (tx) => service.reorderTags(tx, ctx, body.orderedIds)));
    return c.json({ ok: true });
  });

  app.patch("/tags/:id", guard, permit("contact.bulk"), jsonLimit, async (c) => {
    const id = idParam(c);
    const ctx = requestCtx(c);
    const body = await readJson(c, tagInputSchema);
    return c.json(unwrap(await run(c, (tx) => service.updateTag(tx, ctx, id, body))));
  });

  app.delete("/tags/:id", guard, permit("contact.bulk"), async (c) => {
    const id = idParam(c);
    const ctx = requestCtx(c);
    unwrap(await run(c, (tx) => service.deleteTag(tx, ctx, id)));
    return c.json({ ok: true });
  });

  // Listas e segmentos -------------------------------------------------------------------------------------------
  app.get("/contact-lists", guard, async (c) => {
    const ctx = requestCtx(c);
    return c.json(await run(c, (tx) => service.listContactLists(tx, ctx)));
  });

  app.post("/contact-lists", guard, permit("contact.bulk"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, contactListInputSchema);
    return c.json(unwrap(await run(c, (tx) => service.createContactList(tx, ctx, body))), 201);
  });

  app.delete("/contact-lists/:id", guard, permit("contact.bulk"), async (c) => {
    const id = idParam(c);
    const ctx = requestCtx(c);
    unwrap(await run(c, (tx) => service.deleteContactList(tx, ctx, id)));
    return c.json({ ok: true });
  });

  return app;
}
