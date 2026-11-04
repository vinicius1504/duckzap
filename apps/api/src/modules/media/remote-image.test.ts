import { describe, expect, it } from "vitest";
import { MAX_REMOTE_IMAGE_BYTES, createImageFetcher, isAllowedImageUrl } from "./remote-image";

const body = (bytes: Uint8Array, headers: Record<string, string> = {}) => new Response(bytes, { status: 200, headers });

describe("createImageFetcher (download de imagem de link do provedor)", () => {
  it("só busca hosts do WhatsApp/Meta: qualquer outro nem chega à rede", async () => {
    let calls = 0;
    const fetcher = createImageFetcher((async () => {
      calls++;
      return body(new Uint8Array(10));
    }) as unknown as typeof fetch);
    expect(await fetcher("https://evil.example/a.jpg")).toBeNull();
    expect(await fetcher("http://pps.whatsapp.net/a.jpg")).toBeNull();
    expect(await fetcher("https://169.254.169.254/latest")).toBeNull();
    expect(calls).toBe(0);
    expect(isAllowedImageUrl("https://pps.whatsapp.net/v/a.jpg")).toBe(true);
    expect(await fetcher("https://pps.whatsapp.net/v/a.jpg")).toMatchObject({ bytes: Buffer.alloc(10) });
  });

  it("não segue redirecionamento (pede com redirect: error)", async () => {
    let seen: RequestInit | undefined;
    const fetcher = createImageFetcher((async (_url: string, init?: RequestInit) => {
      seen = init;
      return body(new Uint8Array(4));
    }) as unknown as typeof fetch);
    await fetcher("https://pps.whatsapp.net/v/a.jpg");
    expect(seen?.redirect).toBe("error");
  });

  it("respeita o teto de tamanho: declarado no cabeçalho e lido aos poucos; o teto é configurável", async () => {
    const big = new Uint8Array(3000);
    const declared = createImageFetcher((async () => body(big, { "content-length": "3000" })) as unknown as typeof fetch, { maxBytes: 2000 });
    expect(await declared("https://pps.whatsapp.net/v/a.jpg")).toBeNull();
    const streamed = createImageFetcher((async () => body(big)) as unknown as typeof fetch, { maxBytes: 2000 });
    expect(await streamed("https://pps.whatsapp.net/v/a.jpg")).toBeNull();
    const fits = createImageFetcher((async () => body(big)) as unknown as typeof fetch, { maxBytes: 4000 });
    expect((await fits("https://pps.whatsapp.net/v/a.jpg"))?.bytes.length).toBe(3000);
    // padrão: o mesmo teto do catálogo
    expect(MAX_REMOTE_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });

  it("erro de rede ou resposta não-OK viram null (nunca lança)", async () => {
    const boom = createImageFetcher((async () => {
      throw new Error("rede");
    }) as unknown as typeof fetch);
    expect(await boom("https://pps.whatsapp.net/v/a.jpg")).toBeNull();
    const notFound = createImageFetcher((async () => new Response("x", { status: 404 })) as unknown as typeof fetch);
    expect(await notFound("https://pps.whatsapp.net/v/a.jpg")).toBeNull();
  });
});
