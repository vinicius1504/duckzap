import { describe, expect, it } from "vitest";
import { backoffDelay, closePolicy, createDedupe, parseServerMessage, resolveRealtimeUrl } from "./protocol";

describe("parseServerMessage", () => {
  it("aceita ready, ping e event válidos", () => {
    expect(parseServerMessage('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(parseServerMessage('{"type":"ping"}')).toEqual({ type: "ping" });
    const event = { type: "event", id: "e1", at: "2026-01-01T12:00:00.000Z", event: { type: "home.invalidate" } };
    expect(parseServerMessage(JSON.stringify(event))).toEqual(event);
  });

  it("ignora lixo: não-texto, JSON quebrado, tipo desconhecido, evento fora do contrato, mensagem enorme", () => {
    expect(parseServerMessage(undefined)).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseServerMessage("")).toBeNull();
    expect(parseServerMessage("{nope")).toBeNull();
    expect(parseServerMessage('{"type":"hack"}')).toBeNull();
    expect(parseServerMessage('{"type":"event","id":"1","at":"ontem","event":{"type":"home.invalidate"}}')).toBeNull();
    expect(
      parseServerMessage('{"type":"event","id":"1","at":"2026-01-01T12:00:00.000Z","event":{"type":"conversation.message","conversationId":"c"}}'),
    ).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "ready", pad: "x".repeat(20_000) }))).toBeNull();
  });
});

describe("createDedupe", () => {
  it("devolve true só para ids já vistos", () => {
    const d = createDedupe();
    expect(d.seen("a")).toBe(false);
    expect(d.seen("a")).toBe(true);
    expect(d.seen("b")).toBe(false);
  });

  it("guarda só os últimos N ids", () => {
    const d = createDedupe(3);
    for (const id of ["1", "2", "3", "4"]) d.seen(id); // "1" sai
    expect(d.seen("4")).toBe(true);
    expect(d.seen("2")).toBe(true);
    expect(d.seen("1")).toBe(false); // esquecido: conta como novo
  });

  it("clear esquece tudo", () => {
    const d = createDedupe();
    d.seen("a");
    d.clear();
    expect(d.seen("a")).toBe(false);
  });
});

describe("closePolicy", () => {
  it("4401, 4402 e 4403 encerram; o resto reconecta", () => {
    expect(closePolicy(4401)).toEqual({ action: "stop", reason: "unauthorized" });
    expect(closePolicy(4402)).toEqual({ action: "stop", reason: "suspended" });
    expect(closePolicy(4403)).toEqual({ action: "stop", reason: "forbidden_origin" });
    for (const code of [4503, 1000, 1001, 1006, 1011, 1012, 4000, 4404]) expect(closePolicy(code)).toEqual({ action: "retry" });
  });
});

describe("backoffDelay", () => {
  it("dobra a cada tentativa até o teto de 30 s (sem jitter: random = 1)", () => {
    const max = () => 1;
    expect([0, 1, 2, 3, 4, 5, 6, 10, 50].map((n) => backoffDelay(n, max))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  });

  it("jitter fica entre 50% e 100% do valor", () => {
    expect(backoffDelay(3, () => 0)).toBe(4000);
    expect(backoffDelay(3, () => 0.5)).toBe(6000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    for (let n = 0; n < 12; n++) {
      const d = backoffDelay(n);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  it("entradas estranhas não quebram", () => {
    expect(backoffDelay(-5, () => 1)).toBe(1000);
    expect(backoffDelay(Number.NaN, () => 1)).toBe(1000);
    expect(backoffDelay(2, () => 7)).toBe(4000);
  });
});

describe("resolveRealtimeUrl", () => {
  const https = { protocol: "https:", host: "app.duckchat.com.br", hostname: "app.duckchat.com.br" };
  const local = { protocol: "http:", host: "localhost:3000", hostname: "localhost" };

  it("usa a variável de ambiente quando é ws/wss", () => {
    expect(resolveRealtimeUrl({ envUrl: "wss://rt.exemplo.com/ws", isDev: false, location: https })).toBe("wss://rt.exemplo.com/ws");
  });
  it("variável inválida ou de outro protocolo = sem tempo real", () => {
    expect(resolveRealtimeUrl({ envUrl: "https://rt.exemplo.com/ws", isDev: false, location: https })).toBeNull();
    expect(resolveRealtimeUrl({ envUrl: "rt.exemplo.com", isDev: false, location: https })).toBeNull();
  });
  it("em desenvolvimento aponta para a porta 4001 do mesmo host", () => {
    expect(resolveRealtimeUrl({ envUrl: undefined, isDev: true, location: local })).toBe("ws://localhost:4001/ws");
    expect(resolveRealtimeUrl({ envUrl: "  ", isDev: true, location: local })).toBe("ws://localhost:4001/ws");
  });
  it("em produção usa wss no mesmo host", () => {
    expect(resolveRealtimeUrl({ envUrl: undefined, isDev: false, location: https })).toBe("wss://app.duckchat.com.br/ws");
  });
});
