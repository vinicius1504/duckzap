import { describe, expect, it } from "vitest";
import { ProviderError, type ChannelRef } from "../../../lib/messaging";
import { isAllowedImageUrl } from "../../catalog/whatsapp";
import { EvolutionProvider, classifyEvolutionProduct } from "./evolution";
import type { FetchLike } from "./shared";

/** Catálogo do WhatsApp Business via Evolution (`getCatalog`): formato do pedido e normalização. Dados abaixo são todos inventados. */

const channel: ChannelRef = {
  id: "c1",
  organizationId: "org_a",
  credentials: { instanceName: "dz-test-instance", webhookSecret: "dzes_secret_value_123", instanceToken: "INSTANCE-TOKEN-0001" },
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function setup(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call);
  };
  return { provider: new EvolutionProvider({ baseUrl: "http://evolution.test", apiKey: "GLOBAL-KEY-0001", fetch }), calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const product = (over: Record<string, unknown> = {}) => ({
  id: "1001",
  name: "Impressora Epson L3250",
  description: "Tanque de tinta, Wi-Fi.",
  price: 1_299_000, // R$ 1.299,00 em milésimos
  currency: "BRL",
  isHidden: false,
  availability: "in stock",
  imageUrls: { requested: "https://mmg.whatsapp.net/v/t/a.jpg?oh=1", original: "https://mmg.whatsapp.net/v/t/b.jpg?oh=2" },
  ...over,
});

describe("Evolution: classifyEvolutionProduct", () => {
  it("preço em milésimos vira centavos; fotos do WhatsApp entram na ordem pedida/original", () => {
    expect(classifyEvolutionProduct(product())).toEqual({
      externalId: "1001",
      name: "Impressora Epson L3250",
      description: "Tanque de tinta, Wi-Fi.",
      priceCents: 129_900,
      available: true,
      imageUrls: ["https://mmg.whatsapp.net/v/t/a.jpg?oh=1", "https://mmg.whatsapp.net/v/t/b.jpg?oh=2"],
    });
  });

  it("preço zero, ausente, inválido ou em outra moeda = sem preço (a IA não cita valor)", () => {
    expect(classifyEvolutionProduct(product({ price: 0 }))?.priceCents).toBeNull();
    expect(classifyEvolutionProduct(product({ price: undefined }))?.priceCents).toBeNull();
    expect(classifyEvolutionProduct(product({ price: "abc" }))?.priceCents).toBeNull();
    expect(classifyEvolutionProduct(product({ price: -5 }))?.priceCents).toBeNull();
    expect(classifyEvolutionProduct(product({ currency: "USD" }))?.priceCents).toBeNull();
    expect(classifyEvolutionProduct(product({ currency: undefined, price: 59_900 }))?.priceCents).toBe(5990);
    expect(classifyEvolutionProduct(product({ price: "59900" }))?.priceCents).toBe(5990);
  });

  it("escondido ou 'out of stock' = indisponível", () => {
    expect(classifyEvolutionProduct(product({ isHidden: true }))?.available).toBe(false);
    expect(classifyEvolutionProduct(product({ availability: "out of stock" }))?.available).toBe(false);
    expect(classifyEvolutionProduct(product({ availability: "in stock" }))?.available).toBe(true);
  });

  it("sem id ou sem nome não é produto; lixo não lança", () => {
    expect(classifyEvolutionProduct(product({ id: undefined }))).toBeNull();
    expect(classifyEvolutionProduct(product({ name: "   " }))).toBeNull();
    expect(classifyEvolutionProduct(null)).toBeNull();
    expect(classifyEvolutionProduct("x")).toBeNull();
    expect(classifyEvolutionProduct([])).toBeNull();
  });

  it("fotos: só https, sem repetir, no máximo 3", () => {
    const urls = { requested: "https://a.example/1.jpg", original: "http://a.example/2.jpg", x: "https://a.example/1.jpg", y: "https://a.example/3.jpg", z: "https://a.example/4.jpg", w: "https://a.example/5.jpg" };
    expect(classifyEvolutionProduct(product({ imageUrls: urls }))?.imageUrls).toEqual(["https://a.example/1.jpg", "https://a.example/3.jpg", "https://a.example/4.jpg"]);
    expect(classifyEvolutionProduct(product({ imageUrls: undefined }))?.imageUrls).toEqual([]);
  });
});

describe("Evolution: listCatalog", () => {
  it("POST /business/getCatalog/{instância} com o token da instância e devolve os produtos normalizados, sem repetidos", async () => {
    const { provider, calls } = setup(() => json({ wuid: "5567999990000@s.whatsapp.net", numberExists: true, isBusiness: true, catalogLength: 3, catalog: [product(), product({ id: "1002", name: "Tinta Epson 664" }), product()] }));
    const result = await provider.listCatalog(channel);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "http://evolution.test/business/getCatalog/dz-test-instance", method: "POST", body: { limit: 20 } });
    expect(calls[0]!.headers.apikey).toBe("INSTANCE-TOKEN-0001");
    expect(result.isBusiness).toBe(true);
    expect(result.products.map((p) => p.externalId)).toEqual(["1001", "1002"]);
  });

  it("número que não é Business (a Evolution responde 200 sem catálogo) volta isBusiness=false", async () => {
    const { provider } = setup(() => json({ wuid: "5567999990000@s.whatsapp.net", name: null, isBusiness: false }));
    expect(await provider.listCatalog(channel)).toEqual({ isBusiness: false, products: [] });
  });

  it("Business sem produtos é Business com lista vazia", async () => {
    const { provider } = setup(() => json({ isBusiness: true, catalogLength: 0, catalog: [] }));
    expect(await provider.listCatalog(channel)).toEqual({ isBusiness: true, products: [] });
  });

  it("401/403/404 = desconectado; 429/5xx = indisponível; outros 4xx = recusado", async () => {
    const code = async (status: number) => {
      const { provider } = setup(() => json({}, status));
      return provider.listCatalog(channel).then(
        () => "ok",
        (error: unknown) => (error instanceof ProviderError ? error.code : "other"),
      );
    };
    expect(await code(401)).toBe("invalid_credentials");
    expect(await code(403)).toBe("invalid_credentials");
    expect(await code(404)).toBe("invalid_credentials");
    expect(await code(429)).toBe("unavailable");
    expect(await code(500)).toBe("unavailable");
    expect(await code(400)).toBe("rejected");
  });
});

describe("Catálogo do WhatsApp: isAllowedImageUrl", () => {
  it("só https nos servidores de mídia do WhatsApp/Meta", () => {
    expect(isAllowedImageUrl("https://mmg.whatsapp.net/v/t62/a.jpg?oh=1&oe=2")).toBe(true);
    expect(isAllowedImageUrl("https://pps.whatsapp.net/v/a.jpg")).toBe(true);
    expect(isAllowedImageUrl("https://scontent.xx.fbcdn.net/a.jpg")).toBe(true);
  });

  it("recusa http, IP, porta estranha, credencial na URL, outro domínio e sufixo enganoso", () => {
    expect(isAllowedImageUrl("http://mmg.whatsapp.net/a.jpg")).toBe(false);
    expect(isAllowedImageUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isAllowedImageUrl("https://127.0.0.1/a.jpg")).toBe(false);
    expect(isAllowedImageUrl("https://mmg.whatsapp.net:8443/a.jpg")).toBe(false);
    expect(isAllowedImageUrl("https://user:pass@mmg.whatsapp.net/a.jpg")).toBe(false);
    expect(isAllowedImageUrl("https://evil.example/a.jpg")).toBe(false);
    expect(isAllowedImageUrl("https://whatsapp.net.evil.example/a.jpg")).toBe(false);
    expect(isAllowedImageUrl("https://notwhatsapp.net/a.jpg")).toBe(false);
    expect(isAllowedImageUrl("não é url")).toBe(false);
  });
});
