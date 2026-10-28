import { describe, expect, it } from "vitest";
import { clientIp, isIpAllowed, normalizeIp, parseAllowlist } from "./ip";

describe("allowlist de IP", () => {
  it("lista vazia libera todo mundo", () => {
    expect(isIpAllowed("203.0.113.9", [])).toBe(true);
    expect(isIpAllowed(null, [])).toBe(true);
  });

  it("IPv4 exato e CIDR", () => {
    const rules = parseAllowlist(["203.0.113.7", "177.12.40.0/24"]);
    expect(isIpAllowed("203.0.113.7", rules)).toBe(true);
    expect(isIpAllowed("203.0.113.8", rules)).toBe(false);
    expect(isIpAllowed("177.12.40.250", rules)).toBe(true);
    expect(isIpAllowed("177.12.41.1", rules)).toBe(false);
  });

  it("aceita IPv4 mapeado em IPv6 e IPv6 exato", () => {
    const rules = parseAllowlist(["10.0.0.0/8", "2001:db8::1"]);
    expect(isIpAllowed("::ffff:10.1.2.3", rules)).toBe(true);
    expect(isIpAllowed("2001:DB8::1", rules)).toBe(true);
    expect(isIpAllowed("2001:db8::2", rules)).toBe(false);
  });

  it("com lista, IP desconhecido (null) é negado", () => {
    expect(isIpAllowed(null, parseAllowlist(["10.0.0.1"]))).toBe(false);
  });

  it("entrada inválida falha na subida", () => {
    expect(() => parseAllowlist(["abc"])).toThrow();
    expect(() => parseAllowlist(["10.0.0.0/40"])).toThrow();
  });

  it("/0 libera tudo e /32 só um endereço", () => {
    expect(isIpAllowed("8.8.8.8", parseAllowlist(["0.0.0.0/0"]))).toBe(true);
    expect(isIpAllowed("8.8.8.9", parseAllowlist(["8.8.8.8/32"]))).toBe(false);
  });
});

describe("IP do cliente", () => {
  it("sem proxy confiável ignora x-forwarded-for (falsificável)", () => {
    expect(clientIp({ forwardedFor: "1.2.3.4", socketAddress: "::ffff:9.9.9.9", trustProxy: false })).toBe("9.9.9.9");
  });
  it("com proxy confiável usa o último item (o que o proxy acrescentou)", () => {
    expect(clientIp({ forwardedFor: "6.6.6.6, 1.2.3.4", socketAddress: "10.0.0.1", trustProxy: true })).toBe("1.2.3.4");
  });
  it("sem nada, null", () => {
    expect(clientIp({ forwardedFor: undefined, socketAddress: undefined, trustProxy: true })).toBeNull();
    expect(normalizeIp(" ::FFFF:1.1.1.1 ")).toBe("1.1.1.1");
  });
});
