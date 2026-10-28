import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";
import { onError } from "../middleware/error-handler";
import type { AppBindings } from "./context";
import { formatZodError, normalizeValidationErrors, openApiValidationHook } from "./http-validation";

const bodySchema = z.object({
  name: z.string().min(2, "Informe o nome."),
  phone: z.string(),
  nested: z.object({ typeId: z.guid() }).optional(),
});

const route = createRoute({
  method: "post",
  path: "/thing",
  request: { body: { content: { "application/json": { schema: bodySchema } }, required: true } },
  responses: { 200: { description: "ok", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } },
});

/** Sub-app SEM hook (como onboarding/team), montado sob um app que normaliza. */
function makeApp(withHook: boolean) {
  const sub = new OpenAPIHono<AppBindings>();
  sub.openapi(route, (c) => c.json({ ok: true }, 200));
  const root = new OpenAPIHono<AppBindings>(withHook ? { defaultHook: openApiValidationHook } : {});
  root.use("/v1/*", normalizeValidationErrors);
  root.use("/v1/*", async (c, next) => {
    await next();
    c.res.headers.set("x-marker", "kept"); // cabeçalho de middleware interno (CORS etc.) sobrevive à reescrita
  });
  root.route("/v1", sub);
  root.onError(onError);
  return root;
}

const send = (app: ReturnType<typeof makeApp>, body: string) =>
  app.request("/v1/thing", { method: "POST", headers: { "content-type": "application/json" }, body });

describe("validação no formato { error: { code, message, fields } }", () => {
  it("formatZodError nomeia o campo em português e lista todos os problemas", () => {
    const parsed = bodySchema.safeParse({ name: "a", phone: 1, nested: { typeId: "x" } });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const out = formatZodError(parsed.error);
    expect(out.message).toBe('Campo "nome": Informe o nome.');
    expect(out.fields.name).toBe("Informe o nome.");
    expect(Object.keys(out.fields)).toEqual(["name", "phone", "nested.typeId"]);
    expect(out.fields.phone).not.toMatch(/Invalid/); // locale pt-BR
  });

  it("sub-app sem hook (onboarding/equipe) também responde 422 no formato padrão", async () => {
    const res = await send(makeApp(false), JSON.stringify({ name: "a", phone: "1" }));
    expect(res.status).toBe(422);
    expect(res.headers.get("x-marker")).toBe("kept");
    const body = (await res.json()) as { error: { code: string; message: string; fields: Record<string, string> } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toBe('Campo "nome": Informe o nome.');
    expect(body.error.fields.name).toBe("Informe o nome.");
    expect(body).not.toHaveProperty("success");
  });

  it("app com defaultHook também", async () => {
    const res = await send(makeApp(true), JSON.stringify({ phone: "1" }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("corpo que não é JSON dá 400 amigável, sem vazar texto do framework", async () => {
    const res = await send(makeApp(false), "{nao-json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).not.toMatch(/Malformed|JSON/);
  });

  it("entrada válida passa", async () => {
    expect((await send(makeApp(false), JSON.stringify({ name: "Ana", phone: "1" }))).status).toBe(200);
  });
});

describe("error handler — rede de segurança", () => {
  const app = new OpenAPIHono<AppBindings>();
  app.get("/uuid", () => {
    // o que o Drizzle lança com um uuid malformado
    throw Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("invalid input syntax for type uuid"), { code: "22P02" }) });
  });
  app.get("/boom", () => {
    throw new Error("segredo interno");
  });
  app.onError(onError);

  it("id malformado que chegou ao SQL (22P02) vira 422, não 500", async () => {
    const res = await app.request("/uuid");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("erro desconhecido continua 500 genérico, sem detalhe", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("segredo interno");
  });
});
