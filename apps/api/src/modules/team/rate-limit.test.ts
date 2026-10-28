import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createRateLimiter, rateLimitByIp } from "./rate-limit";

describe("limite por janela", () => {
  it("bloqueia depois do máximo e libera na janela seguinte", () => {
    const allow = createRateLimiter({ windowMs: 1000, max: 2 });
    expect(allow("ip", 0)).toBe(true);
    expect(allow("ip", 10)).toBe(true);
    expect(allow("ip", 20)).toBe(false);
    expect(allow("outro", 20)).toBe(true);
    expect(allow("ip", 1001)).toBe(true);
  });
});

describe("limite por IP (aceite de convite)", () => {
  const build = (trustProxy: boolean) => {
    const app = new Hono();
    app.use("*", rateLimitByIp({ windowMs: 60_000, max: 2, scope: "t", trustProxy }));
    app.get("/", (c) => c.text("ok"));
    return app;
  };
  const call = (app: Hono, xff: string) => app.request("/", { headers: { "x-forwarded-for": xff } });

  it("trocar o primeiro item de x-forwarded-for não escapa do limite (atrás do proxy, vale o último)", async () => {
    const app = build(true);
    expect((await call(app, "1.1.1.1, 198.51.100.7")).status).toBe(200);
    expect((await call(app, "2.2.2.2, 198.51.100.7")).status).toBe(200);
    expect((await call(app, "3.3.3.3, 198.51.100.7")).status).toBe(429);
    expect((await call(app, "3.3.3.3, 198.51.100.8")).status).toBe(200);
  });

  it("sem proxy confiável o cabeçalho é ignorado: falsificar IPs não dá balde novo", async () => {
    const app = build(false);
    expect((await call(app, "1.1.1.1")).status).toBe(200);
    expect((await call(app, "2.2.2.2")).status).toBe(200);
    expect((await call(app, "3.3.3.3")).status).toBe(429);
  });
});
