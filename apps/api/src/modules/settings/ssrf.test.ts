import { EventEmitter } from "node:events";
import type { request } from "node:https";
import { describe, expect, it } from "vitest";
import { assertSafeUrl, assertSafeUrlShape, createSafeLookup, isBlockedIp, safePost, UnsafeUrlError } from "./ssrf";

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.169.254", // metadata AWS/GCP/Azure
    "169.254.0.1",
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4 mapeado
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:1", // NAT64 -> 10.0.0.1
    "[::1]",
  ])("bloqueia %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "libera público %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it("texto que não é IP é bloqueado por segurança", () => {
    expect(isBlockedIp("exemplo.com")).toBe(true);
    expect(isBlockedIp("999.1.1.1")).toBe(true);
  });
});

describe("assertSafeUrlShape", () => {
  it.each([
    "http://exemplo.com/hook", // sem https
    "https://localhost/hook",
    "https://app.localhost/hook",
    "https://127.0.0.1/hook",
    "https://[::1]/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://2130706433/hook", // 127.0.0.1 em decimal: o URL normaliza
    "https://0x7f.0.0.1/hook",
    "https://0177.0.0.1/hook", // octal
    "https://servico.internal/hook",
    "https://impressora.local/hook",
    "https://user:senha@exemplo.com/hook",
    "ftp://exemplo.com/hook",
    "nao-e-url",
  ])("recusa %s", (url) => {
    expect(() => assertSafeUrlShape(url)).toThrow(UnsafeUrlError);
  });

  it("aceita https público", () => {
    expect(assertSafeUrlShape("https://exemplo.com.br/api/duckzap").hostname).toBe("exemplo.com.br");
  });
});

describe("assertSafeUrl (DNS)", () => {
  it("recusa nome que resolve para IP interno", async () => {
    await expect(assertSafeUrl("https://parece-publico.com/hook", async () => ["127.0.0.1"])).rejects.toThrow(UnsafeUrlError);
  });

  it("recusa se QUALQUER resposta do DNS for interna (resposta mista)", async () => {
    await expect(assertSafeUrl("https://misto.com/hook", async () => ["8.8.8.8", "10.0.0.7"])).rejects.toThrow(UnsafeUrlError);
  });

  it("recusa metadata da nuvem via DNS", async () => {
    await expect(assertSafeUrl("https://meta.exemplo.com/", async () => ["169.254.169.254"])).rejects.toThrow(UnsafeUrlError);
  });

  it("recusa nome que não resolve", async () => {
    await expect(
      assertSafeUrl("https://nao-existe.exemplo.com/", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("aceita nome que resolve só para IP público", async () => {
    await expect(assertSafeUrl("https://publico.com/hook", async () => ["93.184.216.34"])).resolves.toBeInstanceOf(URL);
  });
});

describe("createSafeLookup (checagem no instante da conexão)", () => {
  it("recusa conexão quando o DNS devolve IP interno (anti DNS rebinding)", async () => {
    const lookup = createSafeLookup(async () => [{ address: "192.168.0.10", family: 4 }]);
    const error = await new Promise<Error | null>((resolve) => lookup("rebind.exemplo.com", {}, (err) => resolve(err)));
    expect(error).toBeInstanceOf(UnsafeUrlError);
  });

  it("entrega o endereço quando é público (com e sem `all`)", async () => {
    const lookup = createSafeLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    const single = await new Promise((resolve) => lookup("ok.com", {}, (_e, address) => resolve(address)));
    expect(single).toBe("93.184.216.34");
    const all = await new Promise((resolve) => lookup("ok.com", { all: true }, (_e, address) => resolve(address)));
    expect(all).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});

/** Transporte falso: cada chamada responde com o próximo status (e `location`, se houver). */
function fakeTransport(responses: { status: number; location?: string }[]) {
  const calls: { url: string; headers: Record<string, unknown>; body: string }[] = [];
  const transport = ((url: URL, options: { headers: Record<string, unknown> }, callback: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: (body: string) => void; destroy: (e?: Error) => void };
    req.destroy = () => undefined;
    req.end = (body: string) => {
      calls.push({ url: url.toString(), headers: options.headers, body });
      const next = responses[calls.length - 1] ?? { status: 200 };
      queueMicrotask(() =>
        callback({ statusCode: next.status, headers: next.location ? { location: next.location } : {}, resume: () => undefined }),
      );
    };
    return req;
  }) as unknown as typeof request;
  return { transport, calls };
}

describe("safePost", () => {
  const publicResolver = async () => ["93.184.216.34"];
  const base = { headers: { "content-type": "application/json" }, body: "{}", resolve: publicResolver };

  it("envia o POST e devolve o status", async () => {
    const { transport, calls } = fakeTransport([{ status: 204 }]);
    const result = await safePost("https://exemplo.com/hook", { ...base, transport });
    expect(result.statusCode).toBe(204);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe("{}");
  });

  it("não envia nada para endereço interno", async () => {
    const { transport, calls } = fakeTransport([{ status: 200 }]);
    await expect(safePost("https://127.0.0.1/hook", { ...base, transport })).rejects.toThrow(UnsafeUrlError);
    expect(calls).toHaveLength(0);
  });

  it("segue redirecionamento para URL pública, validando cada salto", async () => {
    const { transport, calls } = fakeTransport([{ status: 302, location: "https://outro.com/novo" }, { status: 200 }]);
    const result = await safePost("https://exemplo.com/hook", { ...base, transport });
    expect(result.statusCode).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["https://exemplo.com/hook", "https://outro.com/novo"]);
  });

  it("bloqueia redirecionamento para o metadata da nuvem", async () => {
    const { transport, calls } = fakeTransport([{ status: 302, location: "https://169.254.169.254/latest/meta-data" }]);
    await expect(safePost("https://exemplo.com/hook", { ...base, transport })).rejects.toThrow(UnsafeUrlError);
    expect(calls).toHaveLength(1);
  });

  it("bloqueia redirecionamento para http:// e para nome que resolve a IP interno", async () => {
    const downgrade = fakeTransport([{ status: 301, location: "http://exemplo.com/hook" }]);
    await expect(safePost("https://exemplo.com/hook", { ...base, transport: downgrade.transport })).rejects.toThrow(UnsafeUrlError);

    const internal = fakeTransport([{ status: 301, location: "https://interno.exemplo.com/x" }]);
    const resolve = async (host: string) => (host === "interno.exemplo.com" ? ["10.1.1.1"] : ["93.184.216.34"]);
    await expect(safePost("https://exemplo.com/hook", { ...base, resolve, transport: internal.transport })).rejects.toThrow(UnsafeUrlError);
  });

  it("limita a quantidade de redirecionamentos", async () => {
    const loop = Array.from({ length: 10 }, () => ({ status: 302, location: "https://exemplo.com/de-novo" }));
    const { transport } = fakeTransport(loop);
    await expect(safePost("https://exemplo.com/hook", { ...base, transport, maxRedirects: 2 })).rejects.toThrow(UnsafeUrlError);
  });
});
