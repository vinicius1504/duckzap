import { describe, expect, it } from "vitest";
import { clientIp, normalizeIp } from "./client-ip";

const headers = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});

describe("IP do cliente", () => {
  it("sem proxy confiável ignora x-forwarded-for (falsificável) e usa o socket", () => {
    expect(clientIp({ headers: headers("1.2.3.4") }, { trustProxy: false, socketAddress: "203.0.113.9" })).toBe("203.0.113.9");
    expect(clientIp({ headers: headers("1.2.3.4") }, { trustProxy: false })).toBeNull();
  });

  it("com proxy confiável usa o ÚLTIMO item (o que o proxy acrescentou), não o primeiro", () => {
    // o atacante manda "9.9.9.9" e o proxy acrescenta o IP real dele
    expect(clientIp({ headers: headers("9.9.9.9, 198.51.100.7") }, { trustProxy: true, socketAddress: "10.0.0.2" })).toBe("198.51.100.7");
    expect(clientIp({ headers: headers("198.51.100.7") }, { trustProxy: true })).toBe("198.51.100.7");
  });

  it("trocar o primeiro item não muda o IP (limite de login não é burlável)", () => {
    const a = clientIp({ headers: headers("1.1.1.1, 198.51.100.7") }, { trustProxy: true });
    const b = clientIp({ headers: headers("2.2.2.2, 198.51.100.7") }, { trustProxy: true });
    expect(a).toBe(b);
  });

  it("valor inválido no último item cai no socket; sem cabeçalho também", () => {
    expect(clientIp({ headers: headers("1.1.1.1, lixo") }, { trustProxy: true, socketAddress: "10.0.0.2" })).toBe("10.0.0.2");
    expect(clientIp({ headers: headers() }, { trustProxy: true, socketAddress: "10.0.0.2" })).toBe("10.0.0.2");
  });

  it("normaliza IPv4 mapeado em IPv6 e rejeita o que não é IP", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizeIp("abc")).toBeNull();
  });
});
