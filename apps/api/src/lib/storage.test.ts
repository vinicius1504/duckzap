import { describe, expect, it } from "vitest";
import { MemoryObjectStorage, ObjectTooLargeError, S3ObjectStorage, assertSafeKey, contentDisposition, loadStorageConfig, missingStorageVars } from "./storage";

const full = {
  MEDIA_STORAGE_ENDPOINT: "http://minio:9000/",
  MEDIA_STORAGE_PUBLIC_ENDPOINT: "http://localhost:9002",
  MEDIA_STORAGE_BUCKET: "duckzap-media",
  MEDIA_STORAGE_ACCESS_KEY_ID: "AKIATESTTESTTEST",
  MEDIA_STORAGE_SECRET_ACCESS_KEY: "segredo-de-teste-segredo-de-teste",
  MEDIA_STORAGE_FORCE_PATH_STYLE: "true",
};

describe("loadStorageConfig", () => {
  it("sem variáveis o recurso fica desligado (null), não é erro", () => {
    expect(loadStorageConfig({})).toBeNull();
    expect(loadStorageConfig({ MEDIA_STORAGE_ENDPOINT: "   ", MEDIA_STORAGE_BUCKET: "" })).toBeNull();
    expect(missingStorageVars({})).toEqual([]);
  });

  it("variáveis parciais: desligado e missingStorageVars lista o que falta", () => {
    const partial = { MEDIA_STORAGE_ENDPOINT: "https://x.r2.cloudflarestorage.com", MEDIA_STORAGE_BUCKET: "b-media" };
    expect(loadStorageConfig(partial)).toBeNull();
    expect(missingStorageVars(partial)).toEqual(["MEDIA_STORAGE_ACCESS_KEY_ID", "MEDIA_STORAGE_SECRET_ACCESS_KEY"]);
  });

  it("completa: normaliza endpoints, região padrão 'auto', path-style", () => {
    const c = loadStorageConfig(full);
    expect(c).toMatchObject({ endpoint: "http://minio:9000", publicEndpoint: "http://localhost:9002", region: "auto", bucket: "duckzap-media", forcePathStyle: true });
  });

  it("endpoint público padrão = o interno; path-style padrão = false (R2)", () => {
    const { MEDIA_STORAGE_PUBLIC_ENDPOINT: _p, MEDIA_STORAGE_FORCE_PATH_STYLE: _f, ...rest } = full;
    const c = loadStorageConfig({ ...rest, MEDIA_STORAGE_ENDPOINT: "https://acc.r2.cloudflarestorage.com" });
    expect(c).toMatchObject({ endpoint: "https://acc.r2.cloudflarestorage.com", publicEndpoint: "https://acc.r2.cloudflarestorage.com", forcePathStyle: false });
  });

  it("valor inválido lança (o boot mostra o erro)", () => {
    expect(() => loadStorageConfig({ ...full, MEDIA_STORAGE_ENDPOINT: "ftp://x" })).toThrow();
    expect(() => loadStorageConfig({ ...full, MEDIA_STORAGE_BUCKET: "Maiúsculo_Inválido" })).toThrow();
    expect(() => loadStorageConfig({ ...full, MEDIA_SEND_MODE: "nuvem" })).toThrow();
    expect(() => loadStorageConfig({ ...full, MEDIA_STORAGE_FORCE_PATH_STYLE: "talvez" })).toThrow();
  });
});

describe("assertSafeKey / contentDisposition", () => {
  it("recusa chaves com .., barra inicial, barra invertida e controle", () => {
    for (const bad of ["", "/abs", "a/../b", "a\\b", "a\u0000b", "x".repeat(600)]) expect(() => assertSafeKey(bad), bad).toThrow();
    expect(() => assertSafeKey("org/o1/2026-01/abc")).not.toThrow();
  });

  it("nome com acento, aspas e quebra de linha vira cabeçalho seguro", () => {
    const h = contentDisposition('relatório "final"\r\n.pdf', true);
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.startsWith('attachment; filename="')).toBe(true);
    expect(h).toContain("filename*=UTF-8''relat%C3%B3rio");
    expect(contentDisposition("a.png", false).startsWith("inline;")).toBe(true);
  });
});

describe("S3ObjectStorage — URLs assinadas (offline, sem rede)", () => {
  const config = loadStorageConfig(full)!;
  const storage = new S3ObjectStorage(config);

  it("PUT: usa o host PÚBLICO, assina tipo e tamanho exatos, sem checksum automático, e não vaza o segredo", async () => {
    const put = await storage.presignPut("org/o1/2026-01/k1", { contentType: "image/png", contentLength: 1234, expiresInSeconds: 600 });
    const url = new URL(put.url);
    expect(url.origin).toBe("http://localhost:9002");
    expect(url.pathname).toBe("/duckzap-media/org/o1/2026-01/k1");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    const signed = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signed).toContain("content-type");
    expect(signed).toContain("content-length");
    expect([...url.searchParams.keys()].some((k) => k.toLowerCase().includes("checksum"))).toBe(false);
    expect(put.url).not.toContain(config.secretAccessKey);
    expect(put.headers).toEqual({ "Content-Type": "image/png" });
  });

  it("GET: força tipo e nome (download de documento)", async () => {
    const url = new URL(await storage.presignGet("org/o1/2026-01/k1", { expiresInSeconds: 600, contentType: "application/pdf", fileName: "Contrato final.pdf", attachment: true }));
    expect(url.origin).toBe("http://localhost:9002");
    expect(url.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(url.searchParams.get("response-content-disposition")).toMatch(/^attachment; filename="Contrato final.pdf"/);
  });

  it("recusa chave insegura e prefixo curto demais", async () => {
    await expect(storage.presignGet("../x", { expiresInSeconds: 60 })).rejects.toThrow();
    await expect(storage.deletePrefix("org/")).rejects.toThrow();
    await expect(storage.deletePrefix("org/o1")).rejects.toThrow();
  });
});

describe("MemoryObjectStorage", () => {
  it("guarda, lê trecho, limita tamanho, apaga e apaga por prefixo", async () => {
    const m = new MemoryObjectStorage();
    await m.put("org/a/2026-01/1", Buffer.from("0123456789"), { contentType: "text/plain" });
    await m.put("org/a/2026-01/2", Buffer.from("abc"), { contentType: "text/plain" });
    await m.put("org/b/2026-01/1", Buffer.from("zzz"), { contentType: "text/plain" });
    expect(await m.head("org/a/2026-01/1")).toEqual({ sizeBytes: 10, contentType: "text/plain" });
    expect((await m.getRange("org/a/2026-01/1", 0, 3))?.toString()).toBe("0123");
    expect(await m.getObject("nao/existe", { maxBytes: 5 })).toBeNull();
    await expect(m.getObject("org/a/2026-01/1", { maxBytes: 5 })).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(await m.deletePrefix("org/a/")).toBe(2);
    expect(m.objects.size).toBe(1);
    expect(await m.deleteMany(["org/b/2026-01/1", "org/b/2026-01/1"])).toBe(1);
    expect(m.objects.size).toBe(0);
  });
});
