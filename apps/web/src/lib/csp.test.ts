import { describe, expect, it } from "vitest";
import { buildCsp, generateNonce, realtimeOrigin } from "./csp";

describe("buildCsp", () => {
  it("em produção usa nonce + strict-dynamic e fecha o resto", () => {
    const csp = buildCsp({ nonce: "abc123" });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("em desenvolvimento relaxa script e websocket (HMR)", () => {
    const csp = buildCsp({ nonce: "abc123", isDev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("ws:");
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("buildCsp: tempo real", () => {
  const connectSrc = (csp: string) => csp.split("; ").find((d) => d.startsWith("connect-src")) ?? "";

  it("em produção sem URL (mesmo host) o 'self' basta", () => {
    expect(connectSrc(buildCsp({ nonce: "n", realtimeUrl: undefined }))).toBe("connect-src 'self'");
    expect(connectSrc(buildCsp({ nonce: "n", realtimeUrl: "" }))).toBe("connect-src 'self'");
  });

  it("em produção com outro host libera só a origem dele", () => {
    const csp = buildCsp({ nonce: "n", realtimeUrl: "wss://rt.duckchat.com.br/ws?x=1" });
    expect(connectSrc(csp)).toBe("connect-src 'self' wss://rt.duckchat.com.br");
  });

  it("mantém a porta e aceita ws em produção local", () => {
    expect(connectSrc(buildCsp({ nonce: "n", realtimeUrl: "ws://localhost:4001/ws" }))).toBe("connect-src 'self' ws://localhost:4001");
  });

  it("ignora o que não é ws/wss", () => {
    for (const bad of ["https://evil.test/ws", "/ws", "javascript:alert(1)", "wss://a.test; script-src *", "lixo"]) {
      const value = connectSrc(buildCsp({ nonce: "n", realtimeUrl: bad }));
      expect(value, bad).not.toContain(";");
      expect(value, bad).not.toContain("evil.test");
    }
  });

  it("em desenvolvimento continua liberando ws:/wss:", () => {
    expect(connectSrc(buildCsp({ nonce: "n", isDev: true, realtimeUrl: "ws://localhost:4001/ws" }))).toBe("connect-src 'self' ws: wss:");
  });

  it("realtimeOrigin normaliza", () => {
    expect(realtimeOrigin("wss://RT.example.com:8443/ws")).toBe("wss://rt.example.com:8443");
    expect(realtimeOrigin(undefined)).toBeNull();
  });
});

describe("generateNonce", () => {
  it("gera valores diferentes e seguros para header", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(a.length).toBeGreaterThanOrEqual(22);
  });
});
