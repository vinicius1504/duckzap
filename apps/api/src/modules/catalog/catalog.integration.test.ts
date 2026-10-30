import { CATALOG_LIMITS } from "@duckzap/contracts/catalog";
import { createFakeLlm } from "@duckzap/ai";
import { createDb, schema, withOrg } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../../lib/context";
import { MemoryObjectStorage } from "../../lib/storage";
import { onError } from "../../middleware/error-handler";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { createMediaRuntime, getMediaRuntime, setMediaRuntime, type MediaRuntime } from "../media/runtime";
import { mediaRoutes } from "../media/routes";
import { cleanupOrphans } from "../media/service";
import { catalogRoutes } from "./routes";

/**
 * INTEGRAÇÃO — Postgres real (papel `duckzap_app`, sem BYPASSRLS) com a migration do catálogo (0013) e armazenamento EM MEMÓRIA.
 * Rode SOMENTE contra um banco descartável:
 *
 *   CATALOG_INTEGRATION=1 DATABASE_URL=<banco descartável, papel duckzap_app> DATABASE_ADMIN_URL=<dono> npx vitest run src/modules/catalog
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const enabled = process.env.CATALOG_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_ADMIN_URL);

const JPEG = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2000)]);
const PDF = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(1000)]);

type ErrBody = { error: { code: string; message: string } };
type Img = { id: string; mediaId: string; position: number; url: string | null; thumbnailUrl: string | null };
type Prod = { id: string; name: string; description: string; priceCents: number | null; available: boolean; images: Img[]; updatedAt: string };
type List = { products: Prod[]; limit: number };

describe.skipIf(!enabled)("Catálogo — integração (precisa da migration 0013)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 6 });
  afterAll(close);

  const mem = new MemoryObjectStorage("https://media.example.test");
  const unlimited = { take: async () => ({ allowed: true, retryAfterMs: 0 }) };
  const useMedia = (over: Partial<MediaRuntime> = {}) =>
    setMediaRuntime(createMediaRuntime({ storage: mem, sendMode: "base64", storageIsHttps: true, initLimiter: unlimited, completeLimiter: unlimited, ...over }, {}));
  useMedia();
  afterEach(() => useMedia());

  const sessions: Record<string, unknown> = {};
  const deps = {
    db,
    llm: createFakeLlm(),
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null } },
  } as unknown as Deps;
  const app = new OpenAPIHono();
  app.route("/v1", catalogRoutes(deps));
  app.route("/v1", mediaRoutes(deps));
  app.onError(onError);

  const call = (as: string | null, method: string, path: string, body?: unknown) =>
    app.request(`/v1${path}`, {
      method,
      headers: { ...(as ? { "x-test-user": as } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
  const keyOf = (url: string) => decodeURIComponent(new URL(url).pathname.replace(/^\/put\//, ""));

  let main: SecondOrg;
  let other: SecondOrg;
  let bulk: SecondOrg;
  let A = "";
  let seq = 0;
  const name = (label = "Produto") => `${label} ${Math.random().toString(36).slice(2, 8)} ${++seq}`;

  beforeAll(async () => {
    main = await createSecondOrg("catalogo", { extra: [{ key: "agente", role: "member", name: "Rafael Costa" }] });
    other = await createSecondOrg("catalogo-outra");
    bulk = await createSecondOrg("catalogo-lote");
    A = main.orgId;
    sessions.owner = { user: { id: main.userId, name: main.userName, email: main.userEmail }, session: { id: "s1", activeOrganizationId: A } };
    sessions.agent = { user: { id: main.members.agente!.userId, name: "Rafael Costa", email: main.members.agente!.email }, session: { id: "s2", activeOrganizationId: A } };
    sessions.other = { user: { id: other.userId, name: other.userName, email: other.userEmail }, session: { id: "s3", activeOrganizationId: other.orgId } };
    sessions.bulk = { user: { id: bulk.userId, name: bulk.userName, email: bulk.userEmail }, session: { id: "s4", activeOrganizationId: bulk.orgId } };
  });
  afterAll(async () => {
    await main?.remove();
    await other?.remove();
    await bulk?.remove();
  });

  async function create(as = "owner", over: Record<string, unknown> = {}) {
    const res = await call(as, "POST", "/catalog/products", { name: name(), description: "Descrição de teste", priceCents: 5990, ...over });
    if (res.status !== 201) throw new Error(`create ${res.status}: ${JSON.stringify(await res.json())}`);
    return json<Prod>(res);
  }

  /** init → "PUT" no armazenamento em memória → complete. Devolve o mediaId pronto. */
  async function upload(as = "owner", kind = "image", fileName = "foto.jpg", mimeType = "image/jpeg", bytes: Buffer = JPEG()) {
    const init = await call(as, "POST", "/media/uploads", { kind, fileName, mimeType, sizeBytes: bytes.length });
    if (init.status !== 201) throw new Error(`init ${init.status}: ${JSON.stringify(await init.json())}`);
    const data = await json<{ mediaId: string; uploadUrl: string; headers: Record<string, string> }>(init);
    mem.simulatePut(keyOf(data.uploadUrl), bytes, data.headers["Content-Type"] ?? mimeType);
    const complete = await call(as, "POST", `/media/uploads/${data.mediaId}/complete`);
    if (complete.status !== 200) throw new Error(`complete ${complete.status}: ${JSON.stringify(await complete.json())}`);
    return data.mediaId;
  }
  const attach = (productId: string, mediaId: string, as = "owner") => call(as, "POST", `/catalog/products/${productId}/images`, { mediaId });
  const photo = async (productId: string, as = "owner") => {
    const res = await attach(productId, await upload(as), as);
    expect(res.status).toBe(201);
    return json<Prod>(res);
  };
  const mediaRow = (id: string, org = A) => withOrg(db, org, async (tx) => (await tx.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, id)))[0]);
  const list = async (as = "owner") => json<List>(await call(as, "GET", "/catalog/products"));

  // ═══════════════════════════════════════════════════════════════════════════
  describe("cadastro", () => {
    it("cria, lista (ordem alfabética), edita, liga/desliga e apaga", async () => {
      const b = await create("owner", { name: `Bolsa ${seq}-b`, priceCents: 15990, description: "Bolsa de couro" });
      const a = await create("owner", { name: `Anel ${seq}-a`, priceCents: null, available: false });
      expect(b).toMatchObject({ priceCents: 15990, description: "Bolsa de couro", available: true, images: [] });
      expect(a).toMatchObject({ priceCents: null, available: false });

      const all = await list();
      expect(all.limit).toBe(CATALOG_LIMITS.maxProducts);
      const names = all.products.map((p) => p.name);
      expect(names.indexOf(a.name)).toBeLessThan(names.indexOf(b.name));

      const edited = await call("owner", "PATCH", `/catalog/products/${b.id}`, { name: b.name, description: "Nova descrição", priceCents: 9990, available: true });
      expect(edited.status).toBe(200);
      expect(await json<Prod>(edited)).toMatchObject({ id: b.id, description: "Nova descrição", priceCents: 9990 });

      const off = await call("owner", "POST", `/catalog/products/${b.id}/availability`, { available: false });
      expect(await json<Prod>(off)).toMatchObject({ id: b.id, available: false });

      const del = await call("owner", "DELETE", `/catalog/products/${b.id}`);
      expect(del.status).toBe(200);
      expect(await json(del)).toEqual({ ok: true });
      expect((await list()).products.map((p) => p.id)).not.toContain(b.id);
    });

    it("valida entrada: nome vazio, descrição > 500, valor negativo ou fracionado", async () => {
      const base = { name: name(), description: "", priceCents: 100 };
      for (const bad of [{ name: "  " }, { description: "x".repeat(501) }, { priceCents: -1 }, { priceCents: 10.5 }, { name: "n".repeat(81) }]) {
        const res = await call("owner", "POST", "/catalog/products", { ...base, ...bad });
        expect(res.status, JSON.stringify(bad)).toBe(422);
      }
      const ok = await call("owner", "POST", "/catalog/products", { ...base, description: "x".repeat(500) });
      expect(ok.status).toBe(201);
    });

    it("recusa nome repetido (sem diferenciar maiúsculas) ao criar e ao renomear; manter o próprio nome é permitido", async () => {
      const first = await create("owner", { name: `Camiseta Preta M ${seq}` });
      const dup = await call("owner", "POST", "/catalog/products", { name: first.name.toUpperCase(), description: "", priceCents: 1 });
      expect(dup.status).toBe(409);
      expect((await json<ErrBody>(dup)).error.code).toBe("name_taken");

      const second = await create();
      const rename = await call("owner", "PATCH", `/catalog/products/${second.id}`, { name: first.name.toLowerCase(), description: "", priceCents: 1, available: true });
      expect(rename.status).toBe(409);
      expect((await json<ErrBody>(rename)).error.code).toBe("name_taken");

      const self = await call("owner", "PATCH", `/catalog/products/${first.id}`, { name: first.name.toUpperCase(), description: "", priceCents: 1, available: true });
      expect(self.status).toBe(200);
    });

    it("duas empresas podem ter produtos com o mesmo nome", async () => {
      const shared = name("Mesmo nome");
      await create("owner", { name: shared });
      const res = await call("other", "POST", "/catalog/products", { name: shared, description: "", priceCents: 1 });
      expect(res.status).toBe(201);
    });

    it("limite de 100 produtos por empresa", async () => {
      const org = bulk.orgId;
      await withOrg(db, org, (tx) =>
        tx.insert(schema.products).values(Array.from({ length: CATALOG_LIMITS.maxProducts - 1 }, (_, i) => ({ id: uuidv7(), organizationId: org, name: `Item ${i}`, description: "", priceCents: 100 }))),
      );
      const last = await call("bulk", "POST", "/catalog/products", { name: "Item 99", description: "", priceCents: 100 });
      expect(last.status).toBe(201);
      const over = await call("bulk", "POST", "/catalog/products", { name: "Item 100", description: "", priceCents: 100 });
      expect(over.status).toBe(409);
      expect((await json<ErrBody>(over)).error.code).toBe("catalog_full");
      // apagar um libera a vaga
      const created = (await json<Prod>(last)).id;
      expect((await call("bulk", "DELETE", `/catalog/products/${created}`)).status).toBe(200);
      expect((await call("bulk", "POST", "/catalog/products", { name: "Item 100", description: "", priceCents: 100 })).status).toBe(201);
    });

    it("id malformado ou inexistente é 404", async () => {
      expect((await call("owner", "PATCH", "/catalog/products/abc", { name: "x", description: "", priceCents: 1, available: true })).status).toBe(404);
      expect((await call("owner", "DELETE", `/catalog/products/${uuidv7()}`)).status).toBe(404);
      expect((await call("owner", "POST", `/catalog/products/${uuidv7()}/availability`, { available: true })).status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe("fotos", () => {
    it("liga até 3 fotos (posições 0..2, URL assinada) e recusa a 4ª", async () => {
      const p = await create();
      let current = p;
      for (let i = 0; i < 3; i++) current = await photo(p.id);
      expect(current.images.map((i) => i.position)).toEqual([0, 1, 2]);
      expect(current.images.every((i) => i.url?.includes("/get/"))).toBe(true);
      expect((await list()).products.find((x) => x.id === p.id)?.images).toHaveLength(3);

      const fourth = await attach(p.id, await upload());
      expect(fourth.status).toBe(409);
      expect((await json<ErrBody>(fourth)).error.code).toBe("too_many_images");
    });

    it("remover fecha o buraco (a menor posição vira a capa), apaga o arquivo e a vaga é reaproveitada", async () => {
      const p = await create();
      const three = await (async () => {
        await photo(p.id);
        await photo(p.id);
        return photo(p.id);
      })();
      const [cover, middle, last] = three.images;
      const coverKey = (await mediaRow(cover!.mediaId))!.storageKey;
      expect(mem.objects.has(coverKey)).toBe(true);

      const afterCover = await json<Prod>(await call("owner", "DELETE", `/catalog/products/${p.id}/images/${cover!.id}`));
      expect(afterCover.images.map((i) => [i.id, i.position])).toEqual([
        [middle!.id, 0],
        [last!.id, 1],
      ]);
      expect(mem.objects.has(coverKey)).toBe(false);
      expect(await mediaRow(cover!.mediaId)).toBeUndefined();

      const refilled = await photo(p.id);
      expect(refilled.images.map((i) => i.position)).toEqual([0, 1, 2]);
      expect(refilled.images[2]!.id).not.toBe(last!.id);

      const missing = await call("owner", "DELETE", `/catalog/products/${p.id}/images/${uuidv7()}`);
      expect(missing.status).toBe(404);
    });

    it("recusa anexar: arquivo de outra pessoa, de outra empresa, que não é imagem, ainda não conferido ou já usado", async () => {
      const p = await create();
      const q = await create();

      const byAgent = await upload("agent");
      expect((await attach(p.id, byAgent, "owner")).status).toBe(422); // enviado por outra pessoa

      const byOther = await upload("other");
      const crossOrg = await attach(p.id, byOther, "owner");
      expect(crossOrg.status).toBe(422);
      expect((await json<ErrBody>(crossOrg)).error.code).toBe("invalid_media");

      const pdf = await upload("owner", "document", "tabela.pdf", "application/pdf", PDF());
      expect((await attach(p.id, pdf)).status).toBe(422);

      const init = await call("owner", "POST", "/media/uploads", { kind: "image", fileName: "meio.jpg", mimeType: "image/jpeg", sizeBytes: 3000 });
      const pending = (await json<{ mediaId: string }>(init)).mediaId; // sem PUT nem complete
      expect((await attach(p.id, pending)).status).toBe(422);

      const used = await upload();
      expect((await attach(p.id, used)).status).toBe(201);
      expect((await attach(q.id, used)).status).toBe(422); // já é foto de outro produto
      expect((await attach(p.id, used)).status).toBe(422); // e não duplica no mesmo

      const bad = await attach(p.id, "nao-e-um-id");
      expect(bad.status).toBe(422);
      expect((await attach(p.id, uuidv7())).status).toBe(422);
      expect((await attach(uuidv7(), await upload())).status).toBe(404);
    });

    it("arquivo já anexado a uma mensagem não vira foto de produto", async () => {
      const p = await create();
      const mediaId = await upload();
      // simula "já usado em mensagem": precisa de uma mensagem real; cria canal, contato, conversa e mensagem direto no banco
      const messageId = uuidv7();
      await withOrg(db, A, async (tx) => {
        const channelId = uuidv7();
        const contactId = uuidv7();
        const conversationId = uuidv7();
        await tx.insert(schema.channels).values({ id: channelId, organizationId: A, name: `Canal ${seq}`, type: "whatsapp_qr", provider: "evolution", status: "connected", address: "+556733330000", webhookTokenHash: randomBytes(16).toString("hex"), webhookTokenEnc: "x" });
        await tx.insert(schema.contacts).values({ id: contactId, organizationId: A, name: "Cliente", phone: `+55679${Math.floor(10_000_000 + Math.random() * 89_999_999)}` });
        await tx.insert(schema.conversations).values({ id: conversationId, organizationId: A, contactId, channelId });
        await tx.insert(schema.messages).values({ id: messageId, organizationId: A, conversationId, channelId, direction: "out", kind: "image", status: "sent", body: "", senderKind: "member", senderId: main.userId, senderName: main.userName });
        await tx.update(schema.mediaFiles).set({ messageId }).where(eq(schema.mediaFiles.id, mediaId));
      });
      expect((await attach(p.id, mediaId)).status).toBe(422);
    });

    it("sem armazenamento configurado a lista funciona, com url null", async () => {
      const p = await create();
      await photo(p.id);
      useMedia({ storage: null });
      const found = (await list()).products.find((x) => x.id === p.id)!;
      expect(found.images).toHaveLength(1);
      expect(found.images[0]).toMatchObject({ url: null, thumbnailUrl: null });
    });

    it("apagar o produto apaga as fotos: objetos do armazenamento e registros de media_files", async () => {
      const p = await create();
      await photo(p.id);
      const withTwo = await photo(p.id);
      const rows = await Promise.all(withTwo.images.map((i) => mediaRow(i.mediaId)));
      const keys = rows.map((r) => r!.storageKey);
      expect(keys.every((k) => mem.objects.has(k))).toBe(true);

      expect((await call("owner", "DELETE", `/catalog/products/${p.id}`)).status).toBe(200);
      expect(keys.some((k) => mem.objects.has(k))).toBe(false);
      for (const i of withTwo.images) expect(await mediaRow(i.mediaId)).toBeUndefined();
      const left = await withOrg(db, A, (tx) => tx.select().from(schema.productImages).where(eq(schema.productImages.productId, p.id)));
      expect(left).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe("limpeza de órfãos", () => {
    it("cleanupOrphans nunca apaga foto de produto, mas apaga arquivo solto equivalente", async () => {
      const p = await create();
      const withPhoto = await photo(p.id);
      const photoMedia = withPhoto.images[0]!.mediaId;
      const loose = await upload(); // pronto, enviado, nunca usado: órfão depois de 24 h
      const photoRow = (await mediaRow(photoMedia))!;
      const looseRow = (await mediaRow(loose))!;

      const old = new Date(Date.now() - 3 * 86_400_000);
      await withOrg(db, A, (tx) => tx.update(schema.mediaFiles).set({ createdAt: old }).where(inArray(schema.mediaFiles.id, [photoMedia, loose])));

      const removed = await withOrg(db, A, (tx) => cleanupOrphans(tx, A, getMediaRuntime()));
      expect(removed).toBeGreaterThanOrEqual(1);

      expect(await mediaRow(loose)).toBeUndefined();
      expect(mem.objects.has(looseRow.storageKey)).toBe(false);
      expect(await mediaRow(photoMedia)).toBeDefined();
      expect(mem.objects.has(photoRow.storageKey)).toBe(true);
      const shown = (await list()).products.find((x) => x.id === p.id)!;
      expect(shown.images).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe("isolamento e permissões", () => {
    it("outra empresa não vê nem altera o produto (404), e as fotos não vazam", async () => {
      const p = await create();
      const withPhoto = await photo(p.id);
      const img = withPhoto.images[0]!;

      expect((await list("other")).products.map((x) => x.id)).not.toContain(p.id);
      const body = { name: "Invadido", description: "", priceCents: 1, available: true };
      expect((await call("other", "PATCH", `/catalog/products/${p.id}`, body)).status).toBe(404);
      expect((await call("other", "POST", `/catalog/products/${p.id}/availability`, { available: false })).status).toBe(404);
      expect((await call("other", "DELETE", `/catalog/products/${p.id}`)).status).toBe(404);
      expect((await call("other", "DELETE", `/catalog/products/${p.id}/images/${img.id}`)).status).toBe(404);
      expect((await attach(p.id, await upload("other"), "other")).status).toBe(404);

      const intact = (await list()).products.find((x) => x.id === p.id)!;
      expect(intact).toMatchObject({ name: p.name, available: true });
      expect(intact.images).toHaveLength(1);
    });

    it("atendente lê o catálogo mas não escreve (403); sem sessão é 401", async () => {
      const p = await create();
      expect((await call("agent", "GET", "/catalog/products")).status).toBe(200);
      const body = { name: name(), description: "", priceCents: 1, available: true };
      expect((await call("agent", "POST", "/catalog/products", body)).status).toBe(403);
      expect((await call("agent", "PATCH", `/catalog/products/${p.id}`, body)).status).toBe(403);
      expect((await call("agent", "POST", `/catalog/products/${p.id}/availability`, { available: false })).status).toBe(403);
      expect((await call("agent", "DELETE", `/catalog/products/${p.id}`)).status).toBe(403);
      expect((await attach(p.id, await upload("agent"), "agent")).status).toBe(403);
      expect((await call("agent", "DELETE", `/catalog/products/${p.id}/images/${uuidv7()}`)).status).toBe(403);
      expect((await call(null, "GET", "/catalog/products")).status).toBe(401);
      expect((await call(null, "POST", "/catalog/products", body)).status).toBe(401);
    });
  });
});
