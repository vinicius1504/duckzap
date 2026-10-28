import { createDb, withOrg } from "@duckzap/db";
import { sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3ObjectStorage, loadStorageConfig, type ObjectStorage } from "../../lib/storage";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { createMediaRuntime } from "./runtime";
import { cleanupOrphans, completeUpload, createUpload, signMessageMedia } from "./service";

/**
 * INTEGRAÇÃO contra um MinIO/S3 REAL (o do docker-compose.local.yml) e Postgres descartável. Só roda com
 * MEDIA_MINIO_INTEGRATION=1 e MEDIA_STORAGE_* apontando para o MinIO local (recusa qualquer outro endereço: nunca rode isto contra
 * o R2 de produção). Todo objeto fica sob um prefixo único (`org/<empresa de teste>/`) e é apagado no fim.
 *
 *   docker compose -f docker-compose.local.yml up -d minio
 *   MEDIA_MINIO_INTEGRATION=1 MEDIA_STORAGE_ENDPOINT=http://localhost:9002 MEDIA_STORAGE_BUCKET=duckzap-media \
 *     MEDIA_STORAGE_ACCESS_KEY_ID=... MEDIA_STORAGE_SECRET_ACCESS_KEY=... MEDIA_STORAGE_FORCE_PATH_STYLE=true \
 *     DATABASE_URL=<banco descartável> DATABASE_ADMIN_URL=<dono> npx vitest run src/modules/media/media.minio
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
const config = (() => {
  try {
    return loadStorageConfig(process.env);
  } catch {
    return null;
  }
})();
const local = config && /^https?:\/\/(localhost|127\.0\.0\.1|minio)(:\d+)?$/.test(config.endpoint);
const enabled = process.env.MEDIA_MINIO_INTEGRATION === "1" && Boolean(local) && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_ADMIN_URL);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2000)]);

describe.skipIf(!enabled)("Mídia contra MinIO real", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 4 });
  let storage: ObjectStorage;
  let org: SecondOrg;
  const prefixes: string[] = [];

  beforeAll(async () => {
    storage = new S3ObjectStorage(config!);
    org = await createSecondOrg("minio");
    prefixes.push(`org/${org.orgId}/`);
  });
  afterAll(async () => {
    for (const prefix of prefixes) await storage.deletePrefix(prefix).catch(() => {});
    await org?.remove();
    await close();
  });

  const put = (url: string, headers: Record<string, string>, body: Buffer) => fetch(url, { method: "PUT", headers, body });
  const key = () => `org/${org.orgId}/2026-01/${randomUUID()}`;

  describe("armazenamento", () => {
    it("PUT assinado grava; HEAD, intervalo, objeto inteiro e GET assinado leem; apagar some", async () => {
      const k = key();
      const signed = await storage.presignPut(k, { contentType: "image/png", contentLength: PNG.length, expiresInSeconds: 60 });
      const res = await put(signed.url, signed.headers, PNG);
      expect(res.status).toBe(200);

      expect(await storage.head(k)).toEqual({ sizeBytes: PNG.length, contentType: "image/png" });
      expect((await storage.getRange(k, 0, 7))?.equals(PNG.subarray(0, 8))).toBe(true);
      expect((await storage.getObject(k, { maxBytes: 10_000 }))?.equals(PNG)).toBe(true);
      await expect(storage.getObject(k, { maxBytes: 100 })).rejects.toThrow();

      const get = await fetch(await storage.presignGet(k, { expiresInSeconds: 60, contentType: "image/png", fileName: "Foto bonita.png", attachment: true }));
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toBe("image/png");
      expect(get.headers.get("content-disposition")).toMatch(/^attachment; filename="Foto bonita.png"/);
      expect(Buffer.from(await get.arrayBuffer()).equals(PNG)).toBe(true);

      await storage.delete(k);
      expect(await storage.head(k)).toBeNull();
      expect(await storage.getRange(k, 0, 7)).toBeNull();
      await storage.delete(k); // apagar o que não existe não é erro
    });

    it("o armazenamento recusa PUT de outro tamanho ou de outro tipo (o limite está ASSINADO na URL)", async () => {
      const k = key();
      const signed = await storage.presignPut(k, { contentType: "image/png", contentLength: PNG.length, expiresInSeconds: 60 });
      const bigger = await put(signed.url, signed.headers, Buffer.concat([PNG, Buffer.alloc(10)]));
      expect(bigger.status).toBeGreaterThanOrEqual(400);
      const otherType = await put(signed.url, { "Content-Type": "text/html" }, PNG);
      expect(otherType.status).toBeGreaterThanOrEqual(400);
      expect(await storage.head(k)).toBeNull();
    });

    it("URL assinada expirada é recusada", async () => {
      const k = key();
      const signed = await storage.presignPut(k, { contentType: "image/png", contentLength: PNG.length, expiresInSeconds: 1 });
      await new Promise((r) => setTimeout(r, 2200));
      const res = await put(signed.url, signed.headers, PNG);
      expect(res.status).toBe(403);
      expect(await storage.head(k)).toBeNull();
    });

    it("CORS: o navegador do app (localhost:3000) pode fazer PUT e GET direto; outra origem não", async () => {
      const k = key();
      const signed = await storage.presignPut(k, { contentType: "image/png", contentLength: PNG.length, expiresInSeconds: 60 });
      const pre = await fetch(signed.url, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type" },
      });
      expect(pre.status).toBeLessThan(300);
      expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      expect(pre.headers.get("access-control-allow-methods")).toMatch(/PUT/);
      const up = await fetch(signed.url, { method: "PUT", headers: { ...signed.headers, Origin: "http://localhost:3000" }, body: PNG });
      expect(up.status).toBe(200);
      expect(up.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      const evil = await fetch(await storage.presignGet(k, { expiresInSeconds: 60 }), { headers: { Origin: "http://evil.example" } });
      expect(evil.headers.get("access-control-allow-origin")).not.toBe("http://evil.example");
      await storage.delete(k);
    });

    it("deleteMany e deletePrefix apagam em lote (mais de uma página)", async () => {
      const base = `org/${org.orgId}/lote/`;
      const keys = Array.from({ length: 5 }, (_, i) => `${base}${i}`);
      for (const k of keys) await storage.put(k, Buffer.from("x"), { contentType: "text/plain" });
      expect(await storage.deleteMany(keys.slice(0, 2))).toBe(2);
      expect(await storage.head(keys[0]!)).toBeNull();
      expect(await storage.head(keys[4]!)).not.toBeNull();
      expect(await storage.deletePrefix(base)).toBe(3);
      expect(await storage.head(keys[4]!)).toBeNull();
    });
  });

  describe("ciclo completo: init → PUT → complete → leitura assinada", () => {
    const rt = () => createMediaRuntime({ storage });
    const ctx = () => ({ organizationId: org.orgId, userId: org.userId, sendingPaused: false });

    it("imagem válida", async () => {
      const init = await withOrg(db, org.orgId, async (tx) => createUpload(tx, ctx(), { kind: "image", fileName: "foto.png", mimeType: "image/png", sizeBytes: PNG.length }, rt()));
      expect(init.ok).toBe(true);
      if (!init.ok) return;
      expect(init.data.uploadUrl).toMatch(/^http:\/\/localhost:9002\//);
      const res = await put(init.data.uploadUrl, init.data.headers, PNG);
      expect(res.status).toBe(200);

      const done = await withOrg(db, org.orgId, (tx) => completeUpload(tx, ctx(), init.data.mediaId, rt()));
      expect(done).toMatchObject({ ok: true, data: { mediaId: init.data.mediaId, kind: "image", fileName: "foto.png", mimeType: "image/png", sizeBytes: PNG.length } });

      // a URL de leitura só nasce ligada a uma mensagem; aqui conferimos a assinatura direto pela chave guardada
      const [row] = await withOrg(db, org.orgId, (tx) => tx.execute<{ storage_key: string }>(sql`select storage_key from media_files where id = ${init.data.mediaId}`));
      const url = await storage.presignGet(row!.storage_key, { expiresInSeconds: 60, contentType: "image/png", fileName: "foto.png" });
      const get = await fetch(url);
      expect(get.status).toBe(200);
      expect(Buffer.from(await get.arrayBuffer()).equals(PNG)).toBe(true);
    });

    it("PDF falso (conteúdo de executável) é recusado e o objeto é apagado do MinIO", async () => {
      const fake = Buffer.concat([Buffer.from("MZ"), randomBytes(500)]);
      const init = await withOrg(db, org.orgId, (tx) => createUpload(tx, ctx(), { kind: "document", fileName: "contrato.pdf", mimeType: "application/pdf", sizeBytes: fake.length }, rt()));
      if (!init.ok) throw new Error(init.message);
      expect((await put(init.data.uploadUrl, init.data.headers, fake)).status).toBe(200);
      const done = await withOrg(db, org.orgId, (tx) => completeUpload(tx, ctx(), init.data.mediaId, rt()));
      expect(done).toMatchObject({ ok: false, error: "invalid_media" });
      const [row] = await withOrg(db, org.orgId, (tx) => tx.execute<{ storage_key: string; status: string }>(sql`select storage_key, status from media_files where id = ${init.data.mediaId}`));
      expect(row?.status).toBe("deleted");
      expect(await storage.head(row!.storage_key)).toBeNull();
    });

    it("complete sem ter enviado o arquivo avisa, sem descartar o registro", async () => {
      const init = await withOrg(db, org.orgId, (tx) => createUpload(tx, ctx(), { kind: "image", fileName: "nada.png", mimeType: "image/png", sizeBytes: 100 }, rt()));
      if (!init.ok) throw new Error(init.message);
      const done = await withOrg(db, org.orgId, (tx) => completeUpload(tx, ctx(), init.data.mediaId, rt()));
      expect(done).toMatchObject({ ok: false, error: "not_uploaded" });
    });

    it("limpeza oportunista apaga órfãos `uploading` (> 1 h) no armazenamento e no banco", async () => {
      const init = await withOrg(db, org.orgId, (tx) => createUpload(tx, ctx(), { kind: "image", fileName: "orfa.png", mimeType: "image/png", sizeBytes: PNG.length }, rt()));
      if (!init.ok) throw new Error(init.message);
      expect((await put(init.data.uploadUrl, init.data.headers, PNG)).status).toBe(200);
      const [row] = await withOrg(db, org.orgId, (tx) => tx.execute<{ storage_key: string }>(sql`select storage_key from media_files where id = ${init.data.mediaId}`));
      const later = new Date(Date.now() + 2 * 3_600_000);
      const removed = await withOrg(db, org.orgId, (tx) => cleanupOrphans(tx, org.orgId, rt(), later));
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await storage.head(row!.storage_key)).toBeNull();
      const left = await withOrg(db, org.orgId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from media_files where id = ${init.data.mediaId}`));
      expect(left[0]?.n).toBe(0);
    });

    it("signMessageMedia sem mensagens não consulta nem assina nada", async () => {
      const map = await withOrg(db, org.orgId, (tx) => signMessageMedia(tx, org.orgId, [], rt()));
      expect(map.size).toBe(0);
    });
  });
});
