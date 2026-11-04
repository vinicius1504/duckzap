import { createFakeLlm } from "@duckzap/ai";
import { createDb, schema, withOrg } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes, randomInt } from "node:crypto";
import sharp from "sharp";
import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../../lib/context";
import { encryptSecret } from "../../lib/crypto";
import { ProviderError, type InboundEvent, type MessagingProvider, type SendResult } from "../../lib/messaging";
import { MemoryObjectStorage } from "../../lib/storage";
import { onError } from "../../middleware/error-handler";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { loadChannelsConfig } from "../channels/config";
import { InMemoryTokenBucket } from "../channels/rate-limit";
import { createChannelsRuntime, setChannelsRuntime } from "../channels/runtime";
import { loadConversationsConfig } from "../conversations/config";
import { eraseConversationData } from "../conversations/erasure";
import { handleInbound } from "../conversations/inbound";
import { conversationsRoutes } from "../conversations/routes";
import { createConversationsRuntime } from "../conversations/runtime";
import { cleanupOrphans, signContactAvatars } from "../media/service";
import type { ImageFetcher } from "../media/remote-image";
import { createMediaRuntime, setMediaRuntime, type MediaRuntime } from "../media/runtime";
import { AVATAR_MAX_BYTES, AVATAR_REFRESH_MS, createAvatarPort, refreshContactAvatar, type AvatarDeps } from "./avatar";
import { contactsRoutes } from "./routes";
import { deleteContacts } from "./service";

/**
 * INTEGRAÇÃO — Postgres real (papel `duckzap_app`, sem BYPASSRLS) com a migration 0015 (foto de perfil do contato),
 * armazenamento EM MEMÓRIA, provedor e download de imagem FALSOS (nenhuma rede). Rode SOMENTE contra um banco descartável
 * (`scripts/test-all.sh`, com CONVERSATIONS_INTEGRATION=1). Telefones, links e fotos abaixo são inventados.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const enabled = process.env.CONVERSATIONS_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_ADMIN_URL);

const run = Math.random().toString(36).slice(2, 8);
const phone = () => `+55679${randomInt(10_000_000, 99_999_999)}`;
let seq = 0;
const PHOTO_URL = (label = "a") => `https://pps.whatsapp.net/v/t61/${run}-${label}-${++seq}.jpg?oh=SECRET&oe=1`;

const jpeg = (color: string, width = 400, height = 300) => sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
const png = (color: string) => sharp({ create: { width: 100, height: 100, channels: 3, background: color } }).png().toBuffer();

describe.skipIf(!enabled)("Foto de perfil do contato — integração (precisa da migration 0015)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 6 });
  afterAll(close);

  const mem = new MemoryObjectStorage("https://media.example.test");
  const logs: { message: string; meta?: unknown }[] = [];
  const log = { warn: (message: string, meta?: Record<string, unknown>) => void logs.push({ message, meta }), error: (message: string, meta?: Record<string, unknown>) => void logs.push({ message, meta }) };
  const unlimited = { take: async () => ({ allowed: true, retryAfterMs: 0 }) };
  const useMedia = (over: Partial<MediaRuntime> = {}) =>
    setMediaRuntime(createMediaRuntime({ storage: mem, sendMode: "base64", storageIsHttps: true, initLimiter: unlimited, completeLimiter: unlimited, log, ...over }, {}));
  useMedia();

  // Provedor falso: o que a foto de perfil devolve muda por teste
  const profile = { reply: null as string | null | Error, calls: [] as string[] };
  const withPicture: MessagingProvider = {
    kind: "evolution",
    capabilities: () => ({ buttons: false, lists: false, templates: false, media: true, reactions: false, window24h: false, presence: false, mediaBase64: true, downloadMedia: false }),
    connect: async () => ({ status: "connected" }),
    disconnect: async () => {},
    status: async () => "connected",
    send: async (): Promise<SendResult> => ({ ok: true, providerMessageId: `prov-${run}-${++seq}` }),
    verifyWebhook: async () => true,
    parseWebhook: async () => [],
    fetchProfilePicture: async (_channel, input) => {
      profile.calls.push(input.to);
      if (profile.reply instanceof Error) throw profile.reply;
      return profile.reply;
    },
  };
  const { fetchProfilePicture: _omit, ...withoutPictureBase } = withPicture;
  const withoutPicture: MessagingProvider = withoutPictureBase;
  let current: MessagingProvider = withPicture;

  // Download de imagem falso: o que cada link devolve muda por teste
  const images = new Map<string, { bytes: Buffer; contentType: string | undefined } | null>();
  const fetched: string[] = [];
  const fetchImage: ImageFetcher = async (url) => {
    fetched.push(url);
    return images.get(url) ?? null;
  };

  let clock = new Date();
  const channelsConfig = loadChannelsConfig();
  const channelsRt = () => ({ providers: { get: () => current, kinds: () => ["evolution"] }, config: channelsConfig });
  const avatarDeps = (over: Partial<AvatarDeps> = {}): AvatarDeps => ({ db, channels: channelsRt(), media: createMediaRuntime({ storage: mem, log }, {}), fetchImage, limiter: unlimited, now: () => clock, log, ...over });

  afterEach(() => {
    profile.reply = null;
    profile.calls.length = 0;
    fetched.length = 0;
    images.clear();
    logs.length = 0;
    mem.failWith = null;
    current = withPicture;
    clock = new Date();
    useMedia();
  });

  // ── fixtures ──────────────────────────────────────────────────────────────
  let main: SecondOrg;
  let other: SecondOrg;
  let A = "";
  const chan = uuidv7();
  const channelOther = uuidv7();

  async function insertChannel(org: string, id: string, name: string) {
    await withOrg(db, org, (tx) =>
      tx.insert(schema.channels).values({
        id,
        organizationId: org,
        name,
        type: "whatsapp_qr",
        provider: "evolution",
        status: "connected",
        address: "+556733330000",
        webhookTokenHash: createHash("sha256").update(randomBytes(16)).digest("hex"),
        webhookTokenEnc: encryptSecret(org, "token"),
      }),
    );
  }
  async function newContact(org = A, name = "Cliente Foto") {
    const id = uuidv7();
    const number = phone();
    await withOrg(db, org, (tx) => tx.insert(schema.contacts).values({ id, organizationId: org, name, phone: number, origin: "inbound" }));
    return { id, phone: number };
  }
  const contactRow = async (id: string, org = A) => (await withOrg(db, org, (tx) => tx.select().from(schema.contacts).where(eq(schema.contacts.id, id))))[0];
  const mediaOf = async (id: string | null | undefined, org = A) => (id ? (await withOrg(db, org, (tx) => tx.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, id))))[0] : undefined);
  const refresh = (contactId: string, over: Partial<AvatarDeps> = {}, org = A, channelId = chan) => refreshContactAvatar(avatarDeps(over), { organizationId: org, channelId, contactId });
  /** Dá uma foto ao contato (link → imagem) e roda a busca. */
  async function giveAvatar(contactId: string, color = "#336699") {
    const url = PHOTO_URL();
    profile.reply = url;
    images.set(url, { bytes: await jpeg(color), contentType: "image/jpeg" });
    return { url, result: await refresh(contactId) };
  }

  beforeAll(async () => {
    main = await createSecondOrg("avatar", { extra: [{ key: "agente", role: "member", name: "Rafael Costa" }] });
    other = await createSecondOrg("avatar-outra");
    A = main.orgId;
    await insertChannel(A, chan, `Recepção ${run}`);
    await insertChannel(other.orgId, channelOther, `Outra ${run}`);
  });
  afterAll(async () => {
    await main?.remove();
    await other?.remove();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe("buscar e guardar", () => {
    it("pergunta ao provedor, baixa, reduz para um WebP quadrado e liga ao contato", async () => {
      const contact = await newContact();
      const { url, result } = await giveAvatar(contact.id);
      expect(result).toEqual({ ok: true, data: "updated" });
      expect(profile.calls).toEqual([contact.phone]);
      expect(fetched).toEqual([url]);

      const row = (await contactRow(contact.id))!;
      expect(row.avatarMediaId).toBeTruthy();
      expect(row.avatarCheckedAt).toBeInstanceOf(Date);
      const media = (await mediaOf(row.avatarMediaId))!;
      expect(media).toMatchObject({ organizationId: A, kind: "image", mimeType: "image/webp", status: "ready", direction: "in", messageId: null, thumbKey: null, createdBy: null });
      expect(media.storageKey.startsWith(`org/${A}/`)).toBe(true);
      const stored = mem.objects.get(media.storageKey)!;
      expect(stored.contentType).toBe("image/webp");
      const info = await sharp(stored.bytes).metadata();
      expect(info).toMatchObject({ format: "webp", width: 192, height: 192 });
      expect(media.sizeBytes).toBe(stored.bytes.length);
    });

    it("aceita PNG também (o tipo vem dos bytes, não do que o provedor declara)", async () => {
      const contact = await newContact();
      const url = PHOTO_URL("png");
      profile.reply = url;
      images.set(url, { bytes: await png("#aa3355"), contentType: "application/octet-stream" });
      expect(await refresh(contact.id)).toEqual({ ok: true, data: "updated" });
      expect((await contactRow(contact.id))!.avatarMediaId).toBeTruthy();
    });

    it("a limpeza de arquivos soltos nunca apaga a foto de perfil (só o que ninguém usa)", async () => {
      const contact = await newContact();
      await giveAvatar(contact.id);
      const row = (await contactRow(contact.id))!;
      const solto = { id: uuidv7(), key: `org/${A}/2020-01/${uuidv7()}` };
      mem.simulatePut(solto.key, Buffer.from("x"), "image/png");
      await withOrg(db, A, async (tx) => {
        await tx.insert(schema.mediaFiles).values({ id: solto.id, organizationId: A, kind: "image", fileName: "solta.png", mimeType: "image/png", sizeBytes: 1, storageKey: solto.key, status: "ready", direction: "in", createdAt: new Date(Date.now() - 5 * 3_600_000) });
        await cleanupOrphans(tx, A, createMediaRuntime({ storage: mem, log }, {}), new Date(Date.now() + 3 * 3_600_000));
      });
      expect(await mediaOf(solto.id)).toBeUndefined();
      expect(mem.objects.has(solto.key)).toBe(false);
      const media = await mediaOf(row.avatarMediaId);
      expect(media).toBeDefined();
      expect(mem.objects.has(media!.storageKey)).toBe(true);
    });

    it("nada de dado pessoal em log: nem telefone, nem link da foto", async () => {
      const contact = await newContact();
      profile.reply = PHOTO_URL("log");
      // sem imagem para o link: o download falha e isso é logado
      expect(await refresh(contact.id)).toMatchObject({ ok: false, error: "invalid_image" });
      const blob = JSON.stringify(logs);
      expect(logs.length).toBeGreaterThan(0);
      expect(blob).not.toContain(contact.phone);
      expect(blob).not.toContain("whatsapp.net");
      expect(blob).not.toContain("SECRET");
    });
  });

  describe("frequência: no máximo uma tentativa a cada 7 dias", () => {
    it("com foto: a segunda chamada logo em seguida não consulta o provedor", async () => {
      const contact = await newContact();
      await giveAvatar(contact.id);
      profile.calls.length = 0;
      expect(await refresh(contact.id)).toEqual({ ok: true, data: "not_due" });
      expect(profile.calls).toHaveLength(0);
    });

    it("sem foto: grava avatar_checked_at mesmo assim e só pergunta de novo depois de 7 dias", async () => {
      const contact = await newContact();
      profile.reply = null;
      expect(await refresh(contact.id)).toEqual({ ok: true, data: "no_photo" });
      const first = (await contactRow(contact.id))!;
      expect(first.avatarMediaId).toBeNull();
      expect(first.avatarCheckedAt).toBeInstanceOf(Date);
      expect(profile.calls).toHaveLength(1);

      clock = new Date(clock.getTime() + AVATAR_REFRESH_MS - 60_000);
      expect(await refresh(contact.id)).toEqual({ ok: true, data: "not_due" });
      expect(profile.calls).toHaveLength(1);

      // passou a semana e agora o contato tem foto
      clock = new Date(clock.getTime() + 120_000);
      const url = PHOTO_URL();
      profile.reply = url;
      images.set(url, { bytes: await jpeg("#119933"), contentType: "image/jpeg" });
      expect(await refresh(contact.id)).toEqual({ ok: true, data: "updated" });
      expect(profile.calls).toHaveLength(2);
      expect((await contactRow(contact.id))!.avatarMediaId).toBeTruthy();
    });

    it("duas buscas ao mesmo tempo viram uma consulta só", async () => {
      const contact = await newContact();
      const url = PHOTO_URL();
      profile.reply = url;
      images.set(url, { bytes: await jpeg("#555555"), contentType: "image/jpeg" });
      const results = await Promise.all([refresh(contact.id), refresh(contact.id), refresh(contact.id)]);
      expect(results.filter((r) => r.ok && r.data === "updated")).toHaveLength(1);
      expect(profile.calls).toHaveLength(1);
      expect((await contactRow(contact.id))!.avatarMediaId).toBeTruthy();
    });

    it("foto nova substitui a antiga: o objeto e o registro velhos somem", async () => {
      const contact = await newContact();
      await giveAvatar(contact.id, "#111111");
      const old = (await mediaOf((await contactRow(contact.id))!.avatarMediaId))!;
      clock = new Date(clock.getTime() + AVATAR_REFRESH_MS + 1000);
      await giveAvatar(contact.id, "#eeeeee");
      const row = (await contactRow(contact.id))!;
      expect(row.avatarMediaId).not.toBe(old.id);
      expect(await mediaOf(old.id)).toBeUndefined();
      expect(mem.objects.has(old.storageKey)).toBe(false);
      expect(mem.objects.has((await mediaOf(row.avatarMediaId))!.storageKey)).toBe(true);
    });

    it("o contato apagou a foto no WhatsApp: a nossa cópia é apagada", async () => {
      const contact = await newContact();
      await giveAvatar(contact.id);
      const old = (await mediaOf((await contactRow(contact.id))!.avatarMediaId))!;
      clock = new Date(clock.getTime() + AVATAR_REFRESH_MS + 1000);
      profile.reply = null;
      expect(await refresh(contact.id)).toEqual({ ok: true, data: "no_photo" });
      expect((await contactRow(contact.id))!.avatarMediaId).toBeNull();
      expect(await mediaOf(old.id)).toBeUndefined();
      expect(mem.objects.has(old.storageKey)).toBe(false);
    });

    it("limite por canal: sem ficha, nada é gravado e o contato tenta na próxima mensagem", async () => {
      const contact = await newContact();
      const denied = { take: async () => ({ allowed: false, retryAfterMs: 5000 }) };
      expect(await refresh(contact.id, { limiter: denied })).toEqual({ ok: true, data: "rate_limited" });
      expect(profile.calls).toHaveLength(0);
      expect((await contactRow(contact.id))!.avatarCheckedAt).toBeNull();
      // o limitador padrão é um balde por canal
      const bucket = new InMemoryTokenBucket({ capacity: 2, refillPerSecond: 0.001 });
      const [a, b, c] = [await newContact(), await newContact(), await newContact()];
      const outcomes = [];
      for (const x of [a, b, c]) outcomes.push((await refresh(x.id, { limiter: bucket })).ok ? (await contactRow(x.id))!.avatarCheckedAt !== null : null);
      expect(outcomes).toEqual([true, true, false]);
    });
  });

  describe("falhas: nunca quebram e nunca guardam lixo", () => {
    it("erro do provedor vira falha tipada (sem lançar) e só o código vai para o log", async () => {
      const contact = await newContact();
      profile.reply = new ProviderError("unavailable", `O provedor caiu para ${contact.phone}`);
      expect(await refresh(contact.id)).toMatchObject({ ok: false, error: "provider_error" });
      expect((await contactRow(contact.id))!.avatarMediaId).toBeNull();
      expect(JSON.stringify(logs)).not.toContain(contact.phone);
      expect(logs.some((l) => l.message === "contacts.avatar.provider_error" && (l.meta as { code: string }).code === "unavailable")).toBe(true);
    });

    it("link fora dos hosts do WhatsApp é recusado antes de qualquer download", async () => {
      const contact = await newContact();
      for (const bad of ["https://evil.example/foto.jpg", "http://pps.whatsapp.net/foto.jpg", "https://169.254.169.254/latest/meta-data", "https://pps.whatsapp.net.evil.example/a.jpg"]) {
        clock = new Date(clock.getTime() + AVATAR_REFRESH_MS + 1000);
        profile.reply = bad;
        expect(await refresh(contact.id)).toMatchObject({ ok: false, error: "invalid_image" });
      }
      expect(fetched).toHaveLength(0);
      expect((await contactRow(contact.id))!.avatarMediaId).toBeNull();
    });

    it("recusa o que não é imagem de verdade, imagem quebrada e arquivo grande demais (nada vai ao armazenamento)", async () => {
      const contact = await newContact();
      const before = mem.objects.size;
      const cases: { label: string; bytes: Buffer }[] = [
        { label: "pdf", bytes: Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(500)]) },
        { label: "exe", bytes: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(800)]) },
        { label: "jpeg-quebrado", bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(1500)]) },
        { label: "vazio", bytes: Buffer.alloc(0) },
        { label: "grande", bytes: Buffer.concat([await jpeg("#000000"), Buffer.alloc(AVATAR_MAX_BYTES)]) },
      ];
      for (const item of cases) {
        clock = new Date(clock.getTime() + AVATAR_REFRESH_MS + 1000);
        const url = PHOTO_URL(item.label);
        profile.reply = url;
        images.set(url, { bytes: item.bytes, contentType: "image/jpeg" });
        expect(await refresh(contact.id), item.label).toMatchObject({ ok: false, error: "invalid_image" });
      }
      expect(mem.objects.size).toBe(before);
      expect((await contactRow(contact.id))!.avatarMediaId).toBeNull();
    });

    it("download que falha (null) é recusado; armazenamento fora do ar não deixa registro nem objeto", async () => {
      const contact = await newContact();
      profile.reply = PHOTO_URL("sem-bytes");
      expect(await refresh(contact.id)).toMatchObject({ ok: false, error: "invalid_image" });

      clock = new Date(clock.getTime() + AVATAR_REFRESH_MS + 1000);
      const url = PHOTO_URL();
      profile.reply = url;
      images.set(url, { bytes: await jpeg("#abcdef"), contentType: "image/jpeg" });
      const mediaBefore = (await withOrg(db, A, (tx) => tx.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.organizationId, A)))).length;
      mem.failWith = new Error("armazenamento fora do ar");
      expect(await refresh(contact.id, { media: createMediaRuntime({ storage: mem, log }, {}) })).toMatchObject({ ok: false, error: "storage_failed" });
      mem.failWith = null;
      expect((await contactRow(contact.id))!.avatarMediaId).toBeNull();
      expect((await withOrg(db, A, (tx) => tx.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.organizationId, A)))).length).toBe(mediaBefore);
    });

    it("provedor sem foto de perfil (Meta/Instagram) e canal inexistente: nada acontece e nada é gravado", async () => {
      const contact = await newContact();
      current = withoutPicture;
      expect(await refresh(contact.id)).toEqual({ ok: true, data: "unsupported" });
      expect((await contactRow(contact.id))!.avatarCheckedAt).toBeNull();
      current = withPicture;
      expect(await refresh(contact.id, {}, A, uuidv7())).toMatchObject({ ok: false, error: "not_found" });
      expect(await refresh(uuidv7())).toMatchObject({ ok: false, error: "not_found" });
    });

    it("sem armazenamento de mídia configurado: não consulta o provedor", async () => {
      const contact = await newContact();
      expect(await refresh(contact.id, { media: createMediaRuntime({ storage: null }, {}) })).toEqual({ ok: true, data: "storage_off" });
      expect(profile.calls).toHaveLength(0);
      expect((await contactRow(contact.id))!.avatarCheckedAt).toBeNull();
    });
  });

  describe("entrada de mensagem", () => {
    const config = loadConversationsConfig({ CONVERSATIONS_BURST_WINDOW_MS: "0", CONVERSATIONS_BURST_MAX_WAIT_MS: "0", CONVERSATIONS_SWEEP_INTERVAL_MS: "0" });
    const deps = { db, llm: createFakeLlm() } as unknown as Deps;
    const msg = (from: string, over: Partial<Extract<InboundEvent, { type: "message" }>> = {}): InboundEvent => ({
      type: "message",
      externalId: `ext-${run}-${++seq}`,
      from,
      name: "Cliente Novo",
      kind: "text",
      text: "oi",
      at: new Date().toISOString(),
      ...over,
    });
    const messagesOf = (from: string) =>
      withOrg(db, A, async (tx) => {
        const [contact] = await tx.select().from(schema.contacts).where(and(eq(schema.contacts.organizationId, A), eq(schema.contacts.phone, from)));
        return { contact, count: contact ? (await tx.select().from(schema.messages).where(eq(schema.messages.organizationId, A))).length : 0 };
      });

    it("a primeira mensagem dispara a busca em segundo plano; a mensagem já está gravada e a foto aparece depois", async () => {
      setChannelsRuntime(createChannelsRuntime({ config: channelsConfig, providers: { get: () => current, kinds: () => ["evolution"] }, log }));
      const pending: Promise<void>[] = [];
      const avatars = createAvatarPort({ db, background: (task) => void pending.push(task()), fetchImage, limiter: unlimited, media: () => createMediaRuntime({ storage: mem, log }, {}) });
      const rt = createConversationsRuntime(deps, { config, scheduleAiTurn: () => {}, register: false, avatars });
      const from = phone();
      const url = PHOTO_URL("inbound");
      profile.reply = url;
      images.set(url, { bytes: await jpeg("#aa00aa"), contentType: "image/jpeg" });

      const event = msg(from);
      if (event.type !== "message") throw new Error("evento");
      await handleInbound(rt.inbound, { organizationId: A, channelId: chan, event });
      // a mensagem já foi gravada ANTES de a foto terminar
      expect((await messagesOf(from)).contact).toBeDefined();
      expect(pending).toHaveLength(1);
      await Promise.all(pending);
      const contact = (await messagesOf(from)).contact!;
      expect((await contactRow(contact.id))!.avatarMediaId).toBeTruthy();
      expect(profile.calls).toEqual([from]);

      // segunda mensagem: nada novo a buscar
      const second = msg(from);
      if (second.type !== "message") throw new Error("evento");
      await handleInbound(rt.inbound, { organizationId: A, channelId: chan, event: second });
      await Promise.all(pending);
      expect(profile.calls).toHaveLength(1);
    });

    it("erro do provedor não quebra a entrada da mensagem", async () => {
      setChannelsRuntime(createChannelsRuntime({ config: channelsConfig, providers: { get: () => current, kinds: () => ["evolution"] }, log }));
      const pending: Promise<void>[] = [];
      const avatars = createAvatarPort({ db, background: (task) => void pending.push(task()), fetchImage, limiter: unlimited, media: () => createMediaRuntime({ storage: mem, log }, {}) });
      const rt = createConversationsRuntime(deps, { config, scheduleAiTurn: () => {}, register: false, avatars });
      profile.reply = new ProviderError("unavailable", "caiu");
      const from = phone();
      const event = msg(from);
      if (event.type !== "message") throw new Error("evento");
      await expect(handleInbound(rt.inbound, { organizationId: A, channelId: chan, event })).resolves.toBeUndefined();
      await expect(Promise.all(pending)).resolves.toBeDefined();
      expect((await messagesOf(from)).contact).toBeDefined();
      expect((await contactRow((await messagesOf(from)).contact!.id))!.avatarMediaId).toBeNull();
    });

    it("mesmo um gancho que lança (bug) não derruba a mensagem já gravada", async () => {
      const rt = createConversationsRuntime(deps, {
        config,
        scheduleAiTurn: () => {},
        register: false,
        avatars: {
          request: () => {
            throw new Error("bug no gancho");
          },
        },
      });
      const from = phone();
      const event = msg(from);
      if (event.type !== "message") throw new Error("evento");
      await expect(handleInbound(rt.inbound, { organizationId: A, channelId: chan, event })).resolves.toBeUndefined();
      expect((await messagesOf(from)).contact).toBeDefined();
    });

    it("mensagem duplicada (webhook repetido) não dispara busca", async () => {
      const calls: string[] = [];
      const rt = createConversationsRuntime(deps, { config, scheduleAiTurn: () => {}, register: false, avatars: { request: (i) => void calls.push(i.conversationId) } });
      const from = phone();
      const event = msg(from);
      if (event.type !== "message") throw new Error("evento");
      await handleInbound(rt.inbound, { organizationId: A, channelId: chan, event });
      await handleInbound(rt.inbound, { organizationId: A, channelId: chan, event });
      expect(calls).toHaveLength(1);
    });
  });

  describe("LGPD: exclusão do contato", () => {
    const ctx = () => ({ organizationId: A, userId: main.userId, userName: "Marina Alves", timeZone: "America/Sao_Paulo", orgName: "x" });

    it("apagar o contato apaga o objeto e o registro da foto; a de outro contato fica", async () => {
      const mine = await newContact();
      const bystander = await newContact();
      await giveAvatar(mine.id, "#101010");
      clock = new Date();
      await giveAvatar(bystander.id, "#202020");
      const mineMedia = (await mediaOf((await contactRow(mine.id))!.avatarMediaId))!;
      const keepMedia = (await mediaOf((await contactRow(bystander.id))!.avatarMediaId))!;
      expect(mem.objects.has(mineMedia.storageKey)).toBe(true);

      await withOrg(db, A, async (tx) => {
        await eraseConversationData(tx, A, [mine.id]);
        await deleteContacts(tx, ctx(), [mine.id]);
      });
      expect(await contactRow(mine.id)).toBeUndefined();
      expect(await mediaOf(mineMedia.id)).toBeUndefined();
      expect(mem.objects.has(mineMedia.storageKey)).toBe(false);
      expect(await mediaOf(keepMedia.id)).toBeDefined();
      expect(mem.objects.has(keepMedia.storageKey)).toBe(true);
    });

    it("se o armazenamento recusar apagar, a exclusão inteira falha e a foto continua ligada ao contato", async () => {
      const mine = await newContact();
      await giveAvatar(mine.id);
      const media = (await mediaOf((await contactRow(mine.id))!.avatarMediaId))!;
      mem.failWith = new Error("armazenamento fora do ar");
      await expect(
        withOrg(db, A, async (tx) => {
          await eraseConversationData(tx, A, [mine.id]);
          await deleteContacts(tx, ctx(), [mine.id]);
        }),
      ).rejects.toThrow();
      mem.failWith = null;
      expect((await contactRow(mine.id))!.avatarMediaId).toBe(media.id);
      expect(mem.objects.has(media.storageKey)).toBe(true);
    });

    it("contato apagado no meio da busca não ganha foto e não deixa objeto para trás", async () => {
      const contact = await newContact();
      const url = PHOTO_URL();
      profile.reply = url;
      images.set(url, { bytes: await jpeg("#777777"), contentType: "image/jpeg" });
      const before = mem.objects.size;
      // o contato some entre a consulta ao provedor e a gravação
      const racing: typeof fetchImage = async (u) => {
        await withOrg(db, A, (tx) => tx.delete(schema.contacts).where(eq(schema.contacts.id, contact.id)));
        return fetchImage(u);
      };
      expect(await refresh(contact.id, { fetchImage: racing })).toMatchObject({ ok: false, error: "not_found" });
      expect(mem.objects.size).toBe(before);
    });
  });

  describe("isolamento entre empresas (RLS)", () => {
    it("a outra empresa não vê nem assina a foto, e não consegue buscar para um contato desta", async () => {
      const contact = await newContact();
      await giveAvatar(contact.id);
      const row = (await contactRow(contact.id))!;
      expect(await withOrg(db, other.orgId, (tx) => tx.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, row.avatarMediaId!)))).toHaveLength(0);
      expect(await withOrg(db, other.orgId, (tx) => tx.select().from(schema.contacts).where(eq(schema.contacts.id, contact.id)))).toHaveLength(0);
      // assinar com o id da foto desta empresa, estando na outra: nada
      const signed = await withOrg(db, other.orgId, (tx) => signContactAvatars(tx, other.orgId, [{ contactId: contact.id, avatarMediaId: row.avatarMediaId }], createMediaRuntime({ storage: mem, log }, {})));
      expect(signed.size).toBe(0);
      // e a outra empresa não troca a foto de um contato desta
      expect(await refresh(contact.id, {}, other.orgId, channelOther)).toMatchObject({ ok: false, error: "not_found" });
      const stillMine = await withOrg(db, other.orgId, (tx) => tx.update(schema.contacts).set({ avatarMediaId: null }).where(eq(schema.contacts.id, contact.id)).returning());
      expect(stillMine).toHaveLength(0);
      expect((await contactRow(contact.id))!.avatarMediaId).toBe(row.avatarMediaId);
    });
  });

  describe("API: a URL assinada aparece nas respostas", () => {
    const sessions: Record<string, unknown> = {};
    const apiDeps = {
      db,
      llm: createFakeLlm(),
      auth: { api: { getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null } },
    } as unknown as Deps;
    const config = loadConversationsConfig({ CONVERSATIONS_BURST_WINDOW_MS: "0", CONVERSATIONS_BURST_MAX_WAIT_MS: "0", CONVERSATIONS_SWEEP_INTERVAL_MS: "0" });
    const app = new OpenAPIHono();
    app.route("/v1", conversationsRoutes(apiDeps, { config, scheduleAiTurn: () => {}, register: false }));
    app.route("/v1", contactsRoutes(apiDeps));
    app.onError(onError);
    const get = async <T = Record<string, unknown>>(as: string, path: string) => {
      const res = await app.request(`/v1${path}`, { headers: { "x-test-user": as } });
      return { status: res.status, body: (await res.json()) as T };
    };

    type Summary = { id: string; contact: { id: string; avatarUrl?: string | null } };
    beforeAll(() => {
      sessions.owner = { user: { id: main.userId, name: main.userName, email: main.userEmail }, session: { id: "s1", activeOrganizationId: A } };
      sessions.other = { user: { id: other.userId, name: other.userName, email: other.userEmail }, session: { id: "s2", activeOrganizationId: other.orgId } };
    });

    async function withConversation(contactId: string) {
      const id = uuidv7();
      await withOrg(db, A, (tx) =>
        tx.insert(schema.conversations).values({ id, organizationId: A, contactId, channelId: chan, status: "human_active", mode: "human", lastMessageAt: new Date(Date.now() + 60_000), lastMessagePreview: "oi", lastMessageKind: "text", lastMessageDirection: "in" }),
      );
      return id;
    }

    it("lista de conversas, detalhe, lista de clientes e ficha trazem avatarUrl; sem foto é null", async () => {
      const withPhoto = await newContact(A, "Com Foto");
      const noPhoto = await newContact(A, "Sem Foto");
      await giveAvatar(withPhoto.id);
      const media = (await mediaOf((await contactRow(withPhoto.id))!.avatarMediaId))!;
      const convWith = await withConversation(withPhoto.id);
      const convWithout = await withConversation(noPhoto.id);
      const expected = (url: string | null | undefined) => {
        expect(url).toBeTypeOf("string");
        expect(url).toContain(media.storageKey);
        expect(url).toContain("exp=600");
      };

      const list = await get<{ items: Summary[] }>("owner", "/conversations?tab=all");
      expect(list.status).toBe(200);
      expected(list.body.items.find((i) => i.id === convWith)?.contact.avatarUrl);
      expect(list.body.items.find((i) => i.id === convWithout)?.contact.avatarUrl).toBeNull();

      const detail = await get<{ conversation: Summary; contact: { avatarUrl?: string | null } }>("owner", `/conversations/${convWith}`);
      expect(detail.status).toBe(200);
      expected(detail.body.conversation.contact.avatarUrl);
      expected(detail.body.contact.avatarUrl);
      const detailWithout = await get<{ conversation: Summary; contact: { avatarUrl?: string | null } }>("owner", `/conversations/${convWithout}`);
      expect(detailWithout.body.contact.avatarUrl).toBeNull();

      const contactsPage = await get<{ items: { id: string; avatarUrl?: string | null }[] }>("owner", "/contacts?pageSize=100");
      expect(contactsPage.status).toBe(200);
      expected(contactsPage.body.items.find((i) => i.id === withPhoto.id)?.avatarUrl);
      expect(contactsPage.body.items.find((i) => i.id === noPhoto.id)?.avatarUrl).toBeNull();
      const card = await get<{ avatarUrl?: string | null }>("owner", `/contacts/${withPhoto.id}`);
      expected(card.body.avatarUrl);
    });

    it("sem armazenamento a resposta continua 200, com avatarUrl null (as iniciais aparecem)", async () => {
      const contact = await newContact(A, "Foto Offline");
      await giveAvatar(contact.id);
      await withConversation(contact.id);
      useMedia({ storage: null });
      const card = await get<{ avatarUrl?: string | null }>("owner", `/contacts/${contact.id}`);
      expect(card.status).toBe(200);
      expect(card.body.avatarUrl).toBeNull();
      useMedia();
    });

    it("a outra empresa não enxerga o contato nem a foto", async () => {
      const contact = await newContact(A, "Privado");
      await giveAvatar(contact.id);
      const conv = await withConversation(contact.id);
      expect((await get("other", `/contacts/${contact.id}`)).status).toBe(404);
      expect((await get("other", `/conversations/${conv}`)).status).toBe(404);
      const list = await get<{ items: Summary[] }>("other", "/conversations?tab=all");
      expect(list.body.items.some((i) => i.id === conv)).toBe(false);
    });
  });
});
