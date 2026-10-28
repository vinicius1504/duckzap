import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config";
import { createApiSessionValidator } from "../src/session";

describe("parseConfig", () => {
  const base = { REDIS_URL: "redis://:segredo-super@127.0.0.1:6380" };

  it("aplica padrões de desenvolvimento", () => {
    const config = parseConfig(base);
    expect(config).toMatchObject({
      port: 4001,
      apiInternalUrl: "http://127.0.0.1:4000",
      webOrigins: ["http://localhost:3000"],
      maxConnectionsPerUser: 10,
      maxMessageBytes: 1024,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 60_000,
      revalidateIntervalMs: 300_000,
      trustProxy: false,
    });
  });

  it("lê lista de origens e limites", () => {
    const config = parseConfig({ ...base, WEB_ORIGINS: "https://app.x.com, https://b.x.com", REALTIME_PORT: "4101", REALTIME_MAX_CONNECTIONS_PER_USER: "3", REALTIME_TRUST_PROXY: "true" });
    expect(config.webOrigins).toEqual(["https://app.x.com", "https://b.x.com"]);
    expect(config.port).toBe(4101);
    expect(config.maxConnectionsPerUser).toBe(3);
    expect(config.trustProxy).toBe(true);
  });

  it("recusa configuração inválida com mensagem clara e sem vazar valores", () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
    expect(() => parseConfig({})).toThrow(/REDIS_URL/);
    for (const bad of [
      { ...base, WEB_ORIGINS: "*" },
      { ...base, WEB_ORIGINS: "https://app.x.com/" },
      { ...base, WEB_ORIGINS: "https://app.x.com/caminho" },
      { ...base, REALTIME_PORT: "abc" },
      { ...base, REALTIME_PORT: "70000" },
      { ...base, API_INTERNAL_URL: "ftp://x" },
      { REDIS_URL: "http://127.0.0.1:6380" },
      { ...base, REALTIME_PING_INTERVAL_MS: "30000", REALTIME_PONG_TIMEOUT_MS: "10000" },
      { ...base, REALTIME_TRUST_PROXY: "sim" },
    ]) {
      expect(() => parseConfig(bad)).toThrow(ConfigError);
    }
    try {
      parseConfig({ REDIS_URL: "http://:segredo-super@127.0.0.1:6380" });
    } catch (error) {
      expect(String(error)).not.toContain("segredo-super");
    }
  });

  it("em produção exige WEB_ORIGINS e API_INTERNAL_URL explícitos", () => {
    expect(() => parseConfig({ ...base, NODE_ENV: "production" })).toThrow(/WEB_ORIGINS[\s\S]*API_INTERNAL_URL|API_INTERNAL_URL[\s\S]*WEB_ORIGINS/);
    expect(parseConfig({ ...base, NODE_ENV: "production", WEB_ORIGINS: "https://app.x.com", API_INTERNAL_URL: "http://api:4000/" }).apiInternalUrl).toBe("http://api:4000");
  });
});

function fakeFetch(respond: () => Response | Promise<Response>, seen: { url?: string; init?: RequestInit } = {}): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return Promise.resolve(respond());
  }) as unknown as typeof fetch;
}

const sessionBody = (status: string, extra: Record<string, unknown> = {}) => ({
  user: { id: "u1", name: "Ana", email: "ana@x.com", role: "agent" },
  organization: { id: "o1", name: "Loja", plan: "pro", features: [], maxAgents: null, subscriptionStatus: status, timeZone: "America/Sao_Paulo", ...extra },
});

describe("createApiSessionValidator", () => {
  const make = (respond: () => Response | Promise<Response>, seen?: { url?: string; init?: RequestInit }) =>
    createApiSessionValidator({ apiUrl: "http://api:4000/", origin: "http://localhost:3000", timeoutMs: 1000, fetchImpl: fakeFetch(respond, seen) });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("200 válido: devolve empresa e usuário da SESSÃO e repassa cookie e Origin", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const result = await make(() => json(sessionBody("active")), seen)("sid=abc");
    expect(result).toEqual({ kind: "ok", organizationId: "o1", userId: "u1" });
    expect(seen.url).toBe("http://api:4000/v1/me");
    expect(seen.init?.headers).toMatchObject({ cookie: "sid=abc", origin: "http://localhost:3000" });
  });

  it("past_due e trial ainda conectam; expired e canceled são suspensas", async () => {
    expect((await make(() => json(sessionBody("past_due")))("c")).kind).toBe("ok");
    expect((await make(() => json(sessionBody("trial")))("c")).kind).toBe("ok");
    expect((await make(() => json(sessionBody("expired")))("c")).kind).toBe("suspended");
    expect((await make(() => json(sessionBody("canceled")))("c")).kind).toBe("suspended");
  });

  it("401 e 403 (sem empresa) são não autorizado; cookie vazio nem chama a API", async () => {
    let calls = 0;
    const validate = make(() => {
      calls += 1;
      return json({ error: { code: "unauthorized", message: "x" } }, 401);
    });
    expect((await validate("sid=x")).kind).toBe("unauthorized");
    expect((await make(() => json({ error: {} }, 403))("sid=x")).kind).toBe("unauthorized");
    expect((await validate("   ")).kind).toBe("unauthorized");
    expect(calls).toBe(1);
  });

  it("5xx, 429, corpo inesperado, JSON quebrado e erro de rede viram indisponível", async () => {
    expect((await make(() => json({}, 500))("c")).kind).toBe("unavailable");
    expect((await make(() => json({}, 429))("c")).kind).toBe("unavailable");
    expect((await make(() => json({ qualquer: "coisa" }))("c")).kind).toBe("unavailable");
    expect((await make(() => new Response("{quebrado", { status: 200 }))("c")).kind).toBe("unavailable");
    expect((await make(() => Promise.reject(new Error("ECONNREFUSED")))("c")).kind).toBe("unavailable");
  });
});
