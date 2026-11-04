import { CATALOG_LIMITS } from "@duckzap/contracts/catalog";
import { createFakeLlm } from "@duckzap/ai";
import { createDb, schema, withOrg } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../../lib/context";
import { MemoryObjectStorage } from "../../lib/storage";
import { onError } from "../../middleware/error-handler";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { loadChannelsConfig } from "../channels/config";
import { createProviderRegistry } from "../channels/providers/registry";
import type { FetchLike } from "../channels/providers/shared";
import { sealCredentials } from "../channels/repo";
import { createMediaRuntime, setMediaRuntime, type MediaRuntime } from "../media/runtime";
import { catalogRoutes } from "./routes";
import type { ImageFetcher } from "./whatsapp";

/**
 * INTEGRAÇÃO — Postgres real (papel `duckzap_app`) com as migrations do catálogo (0013 e 0014), armazenamento EM MEMÓRIA e a
 * Evolution REAL (adaptador) falando com um `fetch` falso: nenhum acesso à rede; nomes, preços e fotos abaixo são inventados.
 * Rode SOMENTE contra um banco descartável (`scripts/test-all.sh`, com CATALOG_INTEGRATION=1).
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const enabled = process.env.CATALOG_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_ADMIN_URL);

const JPEG = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2000)]);

type Prod = { id: string; name: string; description: string; priceCents: number | null; available: boolean; source: string; images: { id: string; url: string | null }[] };
type Item = { externalId: string; name: string; description: string; priceCents: number | null; available: boolean; imageUrl: string | null; imageCount: number; productId: string | null };
type Cat = { state: string; channels: { id: string; name: string; address: string | null }[]; channelId: string | null; products: Item[] };
type Imported = { created: number; updated: number; turnedOff: number; skipped: { externalId: string; name: string; reason: string }[] };

/** Produto do WhatsApp no formato do Baileys/Evolution (preço em milésimos). */
const wa = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  description: `Descrição de ${name}`,
  price: 89_900,
  currency: "BRL",
  isHidden: false,
  availability: "in stock",
  imageUrls: { requested: `https://mmg.whatsapp.net/v/${id}-a.jpg`, original: `https://mmg.whatsapp.net/v/${id}-b.jpg` },
  ...over,
});

describe.skipIf(!enabled)("Catálogo do WhatsApp Business — integração (precisa das migrations 0013 e 0014)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 6 });
  afterAll(close);

  const mem = new MemoryObjectStorage("https://media.example.test");
  const unlimited = { take: async () => ({ allowed: true, retryAfterMs: 0 }) };
  const useMedia = (over: Partial<MediaRuntime> = {}) =>
    setMediaRuntime(createMediaRuntime({ storage: mem, sendMode: "base64", storageIsHttps: true, initLimiter: unlimited, completeLimiter: unlimited, ...over }, {}));
  useMedia();
  afterEach(() => useMedia());

  // Evolution falsa: o que `getCatalog` devolve muda por teste
  let catalogReply: () => Response = () => new Response("{}", { status: 500 });
  const evolutionCalls: string[] = [];
  const evolutionFetch: FetchLike = async (url) => {
    evolutionCalls.push(url);
    return catalogReply();
  };
  const reply = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const catalogOf = (items: unknown[]) => reply({ wuid: "5567999990000@s.whatsapp.net", numberExists: true, isBusiness: true, catalogLength: items.length, catalog: items });

  const imageCalls: string[] = [];
  const fetchImage: ImageFetcher = async (url) => {
    imageCalls.push(url);
    return url.includes("broken") ? null : { bytes: JPEG(), contentType: "image/jpeg" };
  };

  const config = loadChannelsConfig({ EVOLUTION_URL: "http://evolution.test", EVOLUTION_API_KEY: "GLOBAL-KEY-0001" });
  const providers = createProviderRegistry(config, { fetch: evolutionFetch });
  const whatsapp = () => ({ providers, log: { warn: () => {} } });

  const sessions: Record<string, unknown> = {};
  const deps = {
    db,
    llm: createFakeLlm(),
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null } },
  } as unknown as Deps;
  const app = new OpenAPIHono();
  app.route("/v1", catalogRoutes(deps, { whatsapp, fetchImage, whatsappLimiter: unlimited }));
  app.onError(onError);

  const call = (as: string | null, method: string, path: string, body?: unknown) =>
    app.request(`/v1${path}`, {
      method,
      headers: { ...(as ? { "x-test-user": as } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
  const getCatalog = async (as = "owner", query = "") => json<Cat>(await call(as, "GET", `/catalog/whatsapp${query}`));
  const importItems = (channelId: string, externalIds: string[], as = "owner") => call(as, "POST", "/catalog/whatsapp/import", { channelId, externalIds });
  const importAll = (channelId: string, as = "owner") => call(as, "POST", "/catalog/whatsapp/import", { channelId, all: true });
  const products = async (as = "owner") => (await json<{ products: Prod[] }>(await call(as, "GET", "/catalog/products"))).products;

  async function addChannel(orgId: string, over: { name?: string; status?: string; type?: string } = {}) {
    const id = uuidv7();
    await withOrg(db, orgId, (tx) =>
      tx.insert(schema.channels).values({
        id,
        organizationId: orgId,
        name: over.name ?? "Balcão",
        type: over.type ?? "whatsapp_qr",
        provider: "evolution",
        status: over.status ?? "connected",
        address: "+5567999990000",
        credentialsEnc: sealCredentials(orgId, { instanceName: "dz-test-instance", instanceToken: "INSTANCE-TOKEN-0001" }),
        webhookTokenHash: `hash-${id}`,
        webhookTokenEnc: `enc-${id}`,
      }),
    );
    return id;
  }

  let main: SecondOrg;
  let other: SecondOrg;
  let empty: SecondOrg;
  let A = "";
  let channelId = "";

  beforeAll(async () => {
    main = await createSecondOrg("catwa", { extra: [{ key: "agente", role: "member", name: "Rafael Costa" }] });
    other = await createSecondOrg("catwa-outra");
    empty = await createSecondOrg("catwa-vazia");
    A = main.orgId;
    sessions.owner = { user: { id: main.userId, name: main.userName, email: main.userEmail }, session: { id: "s1", activeOrganizationId: A } };
    sessions.agent = { user: { id: main.members.agente!.userId, name: "Rafael Costa", email: main.members.agente!.email }, session: { id: "s2", activeOrganizationId: A } };
    sessions.other = { user: { id: other.userId, name: other.userName, email: other.userEmail }, session: { id: "s3", activeOrganizationId: other.orgId } };
    sessions.empty = { user: { id: empty.userId, name: empty.userName, email: empty.userEmail }, session: { id: "s4", activeOrganizationId: empty.orgId } };
    channelId = await addChannel(A);
  });
  afterAll(async () => {
    await main?.remove();
    await other?.remove();
    await empty?.remove();
  });

  it("sem WhatsApp por QR Code: estado no_channel; Instagram/oficial não contam", async () => {
    await addChannel(empty.orgId, { type: "instagram", name: "Insta" });
    expect(await getCatalog("empty")).toMatchObject({ state: "no_channel", channels: [], channelId: null, products: [] });
  });

  it("só quem gerencia o catálogo lê e importa (atendente: 403); sem login: 401", async () => {
    expect((await call("agent", "GET", "/catalog/whatsapp")).status).toBe(403);
    expect((await call("agent", "POST", "/catalog/whatsapp/import", { channelId, all: true })).status).toBe(403);
    expect((await call(null, "GET", "/catalog/whatsapp")).status).toBe(401);
  });

  it("lê o catálogo: valor em reais, foto de capa e 'ainda não importado'", async () => {
    catalogReply = catalogOf([wa("p1", "Térmica Elgin i9", { price: 899_000 }), wa("p2", "Tinta Epson 664", { price: 0, imageUrls: undefined }), wa("p3", "Resma A4", { isHidden: true })]);
    const cat = await getCatalog();
    expect(cat.state).toBe("ok");
    expect(cat.channelId).toBe(channelId);
    expect(cat.channels).toEqual([{ id: channelId, name: "Balcão", address: "+5567999990000" }]);
    const byId = Object.fromEntries(cat.products.map((p) => [p.externalId, p]));
    expect(byId.p1).toMatchObject({ name: "Térmica Elgin i9", priceCents: 89_900, available: true, imageCount: 2, imageUrl: "https://mmg.whatsapp.net/v/p1-a.jpg", productId: null });
    expect(byId.p2).toMatchObject({ priceCents: null, imageCount: 0, imageUrl: null });
    expect(byId.p3).toMatchObject({ available: false });
    expect(evolutionCalls.at(-1)).toBe("http://evolution.test/business/getCatalog/dz-test-instance");
  });

  it("canal desconectado, número sem Business e Evolution fora do ar viram estados claros (nunca erro 500)", async () => {
    catalogReply = reply({ wuid: "x", isBusiness: false });
    expect((await getCatalog()).state).toBe("not_business");
    catalogReply = reply({}, 500);
    expect((await getCatalog()).state).toBe("unavailable");
    catalogReply = reply({}, 401);
    expect((await getCatalog()).state).toBe("channel_disconnected");

    const down = await addChannel(A, { name: "Parado", status: "disconnected" });
    const cat = await getCatalog("owner", `?channelId=${down}`);
    expect(cat).toMatchObject({ state: "channel_disconnected", channelId: down, products: [] });
    // conectados vêm primeiro na lista de números
    expect((await getCatalog()).channels.map((c) => c.id)[0]).toBe(channelId);
    await withOrg(db, A, (tx) => tx.delete(schema.channels).where(eq(schema.channels.id, down)));
  });

  it("canal de outra empresa ou inexistente: 404; canal sem QR Code não serve", async () => {
    const foreign = await addChannel(other.orgId, { name: "De outra empresa" });
    expect((await call("owner", "GET", `/catalog/whatsapp?channelId=${foreign}`)).status).toBe(404);
    expect((await importAll(foreign)).status).toBe(404);
    expect((await importAll(uuidv7())).status).toBe(404);
    expect((await importAll("não-é-id")).status).toBe(404);
    const official = await addChannel(A, { type: "whatsapp_official", name: "Oficial" });
    expect((await importAll(official)).status).toBe(404);
  });

  it("importar escolhe os marcados: cria cópia 'whatsapp', baixa até 3 fotos e a lista passa a marcar 'importado'", async () => {
    catalogReply = catalogOf([wa("i1", "Impressora Brother DCP"), wa("i2", "Cartucho HP 667"), wa("i3", "Não importar")]);
    imageCalls.length = 0;
    const res = await importItems(channelId, ["i1", "i2"]);
    expect(res.status).toBe(200);
    expect(await json<Imported>(res)).toEqual({ created: 2, updated: 0, turnedOff: 0, skipped: [] });
    expect(imageCalls).toHaveLength(4);

    const list = await products();
    const brother = list.find((p) => p.name === "Impressora Brother DCP")!;
    expect(brother).toMatchObject({ source: "whatsapp", priceCents: 8990, available: true, description: "Descrição de Impressora Brother DCP" });
    expect(brother.images).toHaveLength(2);
    expect(brother.images.every((img) => img.url)).toBe(true);
    expect(list.find((p) => p.name === "Não importar")).toBeUndefined();

    const cat = await getCatalog();
    expect(cat.products.find((p) => p.externalId === "i1")?.productId).toBe(brother.id);
    expect(cat.products.find((p) => p.externalId === "i3")?.productId).toBeNull();
  });

  it("importar de novo atualiza nome, descrição e valor sem duplicar nem baixar as fotos outra vez", async () => {
    imageCalls.length = 0;
    catalogReply = catalogOf([wa("i1", "Impressora Brother DCP L2540", { price: 1_500_000, description: "Nova descrição" })]);
    const before = (await products()).find((p) => p.name === "Impressora Brother DCP")!;
    const res = await json<Imported>(await importItems(channelId, ["i1"]));
    expect(res).toEqual({ created: 0, updated: 1, turnedOff: 0, skipped: [] });
    expect(imageCalls).toHaveLength(0);
    const after = (await products()).find((p) => p.id === before.id)!;
    expect(after).toMatchObject({ name: "Impressora Brother DCP L2540", priceCents: 150_000, description: "Nova descrição" });
    expect(after.images.map((i) => i.id)).toEqual(before.images.map((i) => i.id));
  });

  it("a equipe desligou o produto: importar de novo NÃO religa; o WhatsApp esconder desliga", async () => {
    const list = await products();
    const hp = list.find((p) => p.name === "Cartucho HP 667")!;
    expect((await call("owner", "POST", `/catalog/products/${hp.id}/availability`, { available: false })).status).toBe(200);
    catalogReply = catalogOf([wa("i1", "Impressora Brother DCP L2540", { isHidden: true }), wa("i2", "Cartucho HP 667")]);
    await importItems(channelId, ["i1", "i2"]);
    const after = await products();
    expect(after.find((p) => p.name === "Cartucho HP 667")?.available).toBe(false);
    expect(after.find((p) => p.name === "Impressora Brother DCP L2540")?.available).toBe(false);
  });

  it("produto do WhatsApp é somente leitura: editar e mexer nas fotos dá 409; ligar/desligar e excluir valem", async () => {
    const hp = (await products()).find((p) => p.name === "Cartucho HP 667")!;
    const edit = await call("owner", "PATCH", `/catalog/products/${hp.id}`, { name: "Outro nome", description: "", priceCents: 100, available: true });
    expect(edit.status).toBe(409);
    expect((await json<{ error: { code: string } }>(edit)).error.code).toBe("read_only");
    const attach = await call("owner", "POST", `/catalog/products/${hp.id}/images`, { mediaId: uuidv7() });
    expect(attach.status).toBe(409);
    expect((await call("owner", "DELETE", `/catalog/products/${hp.id}/images/${hp.images[0]!.id}`)).status).toBe(409);
    expect((await call("owner", "POST", `/catalog/products/${hp.id}/availability`, { available: true })).status).toBe(200);

    const keys = (await products()).find((p) => p.id === hp.id)!.images.length;
    expect(keys).toBeGreaterThan(0);
    expect((await call("owner", "DELETE", `/catalog/products/${hp.id}`)).status).toBe(200);
    expect((await products()).find((p) => p.id === hp.id)).toBeUndefined();
  });

  it("nome já usado por outro produto do sistema: pula e explica; os demais entram", async () => {
    const created = await call("owner", "POST", "/catalog/products", { name: "Papel A4 Chamex", description: "", priceCents: 2990, available: true });
    expect(created.status).toBe(201);
    catalogReply = catalogOf([wa("n1", "papel a4 chamex"), wa("n2", "Toner HP 105A")]);
    const res = await json<Imported>(await importItems(channelId, ["n1", "n2"]));
    expect(res.created).toBe(1);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatchObject({ externalId: "n1", name: "papel a4 chamex" });
    expect(res.skipped[0]!.reason).toMatch(/nome/i);
    expect((await products()).filter((p) => p.name.toLowerCase() === "papel a4 chamex")).toHaveLength(1);
  });

  it("foto que não baixa não impede a importação; produto entra sem foto e ganha quando der", async () => {
    catalogReply = catalogOf([wa("f1", "Cabo USB-B", { imageUrls: { requested: "https://mmg.whatsapp.net/v/broken.jpg" } })]);
    const res = await json<Imported>(await importItems(channelId, ["f1"]));
    expect(res.created).toBe(1);
    expect((await products()).find((p) => p.name === "Cabo USB-B")!.images).toHaveLength(0);

    imageCalls.length = 0;
    catalogReply = catalogOf([wa("f1", "Cabo USB-B")]);
    expect((await json<Imported>(await importItems(channelId, ["f1"]))).updated).toBe(1);
    expect(imageCalls.length).toBeGreaterThan(0);
    expect((await products()).find((p) => p.name === "Cabo USB-B")!.images.length).toBeGreaterThan(0);
  });

  it("id que não está mais no catálogo do WhatsApp é pulado com aviso", async () => {
    catalogReply = catalogOf([wa("x1", "Qualquer")]);
    const res = await json<Imported>(await importItems(channelId, ["sumiu"]));
    expect(res.created + res.updated).toBe(0);
    expect(res.skipped[0]).toMatchObject({ externalId: "sumiu" });
  });

  it("'importar todos' atualiza o que existe e DESLIGA os importados que saíram do catálogo do WhatsApp", async () => {
    catalogReply = catalogOf([wa("a1", "Roteador TP-Link"), wa("a2", "Switch 8 portas"), wa("a3", "Patch panel")]);
    expect((await json<Imported>(await importItems(channelId, ["a1", "a2", "a3"]))).created).toBe(3);
    const stillThere = (await products()).filter((p) => p.source === "whatsapp" && p.available);
    expect(stillThere.length).toBeGreaterThan(3); // os de testes anteriores ainda estão ligados

    // o catálogo do WhatsApp agora só tem a1 e a2 (e a3 saiu): todos os outros importados são desligados
    catalogReply = catalogOf([wa("a1", "Roteador TP-Link"), wa("a2", "Switch 8 portas")]);
    const res = await json<Imported>(await importAll(channelId));
    expect(res.created).toBe(0);
    expect(res.updated).toBe(2);
    expect(res.turnedOff).toBe(stillThere.length - 2);
    const left = (await products()).filter((p) => p.source === "whatsapp" && p.available);
    expect(left.map((p) => p.name).sort()).toEqual(["Roteador TP-Link", "Switch 8 portas"]);
    // produtos do sistema não são tocados
    expect((await products()).find((p) => p.name === "Papel A4 Chamex")?.available).toBe(true);
  });

  it("importar exige escolher produtos ou 'todos' (nunca os dois, nunca nenhum)", async () => {
    expect((await call("owner", "POST", "/catalog/whatsapp/import", { channelId })).status).toBe(422);
    expect((await call("owner", "POST", "/catalog/whatsapp/import", { channelId, all: true, externalIds: ["a1"] })).status).toBe(422);
    expect((await call("owner", "POST", "/catalog/whatsapp/import", { channelId, externalIds: [] })).status).toBe(422);
  });

  it("respeita o limite de produtos do catálogo: o que passa dele é pulado", async () => {
    const full = await createSecondOrg("catwa-cheia");
    sessions.full = { user: { id: full.userId, name: full.userName, email: full.userEmail }, session: { id: "s9", activeOrganizationId: full.orgId } };
    try {
      const ch = await addChannel(full.orgId);
      await withOrg(db, full.orgId, async (tx) => {
        for (let i = 0; i < CATALOG_LIMITS.maxProducts; i++) await tx.insert(schema.products).values({ id: uuidv7(), organizationId: full.orgId, name: `Produto ${i}` });
      });
      catalogReply = catalogOf([wa("l1", "Excedente")]);
      const res = await json<Imported>(await importItems(ch, ["l1"], "full"));
      expect(res.created).toBe(0);
      expect(res.skipped[0]).toMatchObject({ externalId: "l1" });
    } finally {
      await full.remove();
    }
  });
});
