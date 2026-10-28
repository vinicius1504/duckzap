import type { Hook } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppBindings } from "./context";

// Mensagens padrão do Zod (as que nenhum contrato escreveu à mão) saem em português.
z.config(z.locales.ptBR());

/** Nome do campo como a pessoa o vê. O que não está aqui aparece com o nome técnico. */
const FIELD_LABELS: Record<string, string> = {
  name: "nome",
  phone: "telefone",
  email: "e-mail",
  password: "senha",
  instagram: "Instagram",
  birthDate: "data de nascimento",
  origin: "origem",
  originNote: "detalhe da origem",
  ownerId: "responsável",
  tagIds: "etiquetas",
  tagId: "etiqueta",
  listId: "lista",
  contactId: "cliente",
  contactIds: "clientes",
  typeId: "tipo de atendimento",
  importId: "importação",
  channelId: "canal",
  date: "data",
  time: "hora",
  durationMinutes: "duração",
  notes: "observações",
  subject: "assunto",
  message: "mensagem",
  question: "pergunta",
  text: "texto",
  timeZone: "fuso horário",
  status: "status",
};

export type ValidationFields = Record<string, string>;
export type ValidationFailure = { message: string; fields: ValidationFields };

function fieldPath(path: readonly PropertyKey[]) {
  return path.map((part) => String(part)).join(".");
}

function fieldLabel(path: readonly PropertyKey[]) {
  const last = [...path].reverse().find((part) => typeof part === "string");
  if (last === undefined) return null;
  return FIELD_LABELS[String(last)] ?? fieldPath(path);
}

/** Primeira mensagem legível (`Campo "telefone": ...`) e o mapa campo → mensagem de todos os problemas. */
export function formatZodError(error: z.ZodError): ValidationFailure {
  const fields: ValidationFields = {};
  let message: string | null = null;
  for (const issue of error.issues) {
    const label = fieldLabel(issue.path);
    const text = label ? `Campo "${label}": ${issue.message}` : issue.message;
    message ??= text;
    const key = fieldPath(issue.path) || "_";
    fields[key] ??= issue.message;
  }
  return { message: message ?? "Confira os campos.", fields };
}

export function validationBody(failure: ValidationFailure) {
  return { error: { code: "validation_error", message: failure.message, fields: failure.fields } };
}

/** `defaultHook` do OpenAPIHono: validação de rota declarada (`createRoute`) responde 422 no formato da API. */
export const openApiValidationHook: Hook<unknown, AppBindings, string, unknown> = (result, c) => {
  if (!result.success) return c.json(validationBody(formatZodError(result.error)), 422);
  return undefined;
};

/**
 * Sub-apps criam o próprio OpenAPIHono (sem o hook acima) e o validador padrão responde 400 com o ZodError cru
 * (`{ success: false, error }`). Este middleware reescreve só essa resposta para o formato `{ error: { code, message } }` (422).
 */
export const normalizeValidationErrors: MiddlewareHandler<AppBindings> = async (c, next) => {
  await next();
  const res = c.res;
  if (res.status !== 400 || !res.headers.get("content-type")?.includes("application/json")) return;
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null);
  const issues = rawZodIssues(body);
  if (!issues) return;
  // mantém os cabeçalhos já aplicados (CORS, request id) e troca só status e corpo
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  c.res = new Response(JSON.stringify(validationBody(formatZodError(new z.ZodError(issues)))), { status: 422, headers });
};

/** O validador padrão responde `{ success: false, error: { name: "ZodError", message: "<JSON dos issues>" } }`. */
function rawZodIssues(body: unknown): z.core.$ZodIssue[] | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as { success?: unknown; error?: { name?: unknown; message?: unknown; issues?: unknown } };
  if (record.success !== false || !record.error) return null;
  if (Array.isArray(record.error.issues)) return record.error.issues as z.core.$ZodIssue[];
  if (record.error.name !== "ZodError" || typeof record.error.message !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(record.error.message);
    return Array.isArray(parsed) ? (parsed as z.core.$ZodIssue[]) : null;
  } catch {
    return null;
  }
}

/** Atalho para quem já tem um `Context`: 422 no formato padrão a partir de um ZodError. */
export function validationResponse(c: Context, error: z.ZodError) {
  return c.json(validationBody(formatZodError(error)), 422);
}
