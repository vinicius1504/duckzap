import { createFakeLlm } from "@duckzap/ai";
import { createDb, schema, withOrg } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Deps } from "../../lib/context";
import { encryptSecret } from "../../lib/crypto";
import { ProviderError, type DownloadedMedia, type InboundEvent, type MessagingProvider, type OutboundMessage, type SendResult } from "../../lib/messaging";
import { MemoryObjectStorage } from "../../lib/storage";
import { onError } from "../../middleware/error-handler";
import { loadChannelsConfig } from "../channels/config";
import { InMemoryTokenBucket } from "../channels/rate-limit";
import { createChannelsRuntime, setChannelsRuntime } from "../channels/runtime";
import { deleteContacts } from "../contacts/service";
import { loadConversationsConfig } from "../conversations/config";
import { eraseConversationData } from "../conversations/erasure";
import { handleInbound } from "../conversations/inbound";
import { conversationsRoutes } from "../conversations/routes";
import { createConversationsRuntime } from "../conversations/runtime";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { createInboundMediaPort } from "./inbound";
import { MAX_INBOUND_BYTES } from "./logic";
import { mediaRoutes } from "./routes";
import { createMediaRuntime, setMediaRuntime, type MediaRuntime } from "./runtime";

/**
 * INTEGRAÇÃO — Postgres real (papel `duckzap_app`, sem BYPASSRLS) com a migration `media_files`, armazenamento EM MEMÓRIA e
 * provedor de mensagens falso. Rode SOMENTE contra um banco descartável:
 *
 *   MEDIA_INTEGRATION=1 DATABASE_URL=<banco descartável, papel duckzap_app> DATABASE_ADMIN_URL=<dono> npx vitest run src/modules/media
 *
 * O ciclo contra um MinIO de verdade está em `media.minio.integration.test.ts`.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const enabled = process.env.MEDIA_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_ADMIN_URL);

const run = Math.random().toString(36).slice(2, 8);
const phone = () => `+55679${randomInt(10_000_000, 99_999_999)}`;
let seq = 0;
const extId = (label = "m") => `ext-${run}-${label}-${++seq}`;

const HOST = "https://media.example.test";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(3000)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2000)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(1500)]);
const OGG = Buffer.concat([Buffer.from("OggS\u0000\u0002"), randomBytes(1500)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]), randomBytes(1500)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(800, 0)]);
const ZIP = Buffer.concat([Buffer.from("PK\u0003\u0004"), randomBytes(500)]);

/** Provedor falso: grava o que recebeu, tem mídia por base64 ligável e downloads controlados pelo teste. */
function fakeProvider() {
  const sent: OutboundMessage[] = [];
  const downloads = new Map<string, DownloadedMedia | Error>();
  const downloadCalls: string[] = [];
  const state = { base64: true, failNextSend: false, downloadDelayMs: 0 };
  let n = 0;
  const provider: MessagingProvider = {
    kind: "evolution",
    capabilities: () => ({ buttons: false, lists: false, templates: false, media: true, reactions: false, window24h: false, presence: false, mediaBase64: state.base64, downloadMedia: true }),
    connect: async () => ({ status: "connected" }),
    disconnect: async () => {},
    status: async () => "connected",
    send: async (_channel, message): Promise<SendResult> => {
      sent.push(message);
      if (state.failNextSend) {
        state.failNextSend = false;
        return { ok: false, code: "unknown", message: "O provedor falhou ao enviar." };
      }
      return { ok: true, providerMessageId: `prov-${run}-${++n}` };
    },
    verifyWebhook: async () => true,
    parseWebhook: async () => [],
    downloadMedia: async (_channel, input) => {
      downloadCalls.push(input.externalId);
      if (state.downloadDelayMs) await new Promise((r) => setTimeout(r, state.downloadDelayMs));
      const found = downloads.get(input.externalId);
      if (!found) throw new ProviderError("rejected", "O provedor não devolveu o arquivo.");
      if (found instanceof Error) throw found;
      return found;
    },
  };
  return { provider, sent, downloads, downloadCalls, state };
}

describe.skipIf(!enabled)("Mídia de conversa — integração (precisa da migration media_files)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 6 });
  afterAll(close);

  const fake = fakeProvider();
  setChannelsRuntime(
    createChannelsRuntime({
      config: loadChannelsConfig({ CHANNELS_SEND_BURST_QR: "100", CHANNELS_SEND_PER_SECOND_QR: "100" }),
      providers: { get: () => fake.provider, kinds: () => ["evolution"] },
      sendLimiterFor: () => new InMemoryTokenBucket({ capacity: 1000, refillPerSecond: 1000 }),
    }),
  );

  const mem = new MemoryObjectStorage(HOST);
  const unlimited = { take: async () => ({ allowed: true, retryAfterMs: 0 }) };
  const logs: { message: string; meta?: unknown }[] = [];
  /** Troca a configuração de mídia do processo (armazenamento, modo de envio, limites). */
  function useMedia(over: Partial<MediaRuntime> = {}) {
    setMediaRuntime(
      createMediaRuntime(
        {
          storage: mem,
          sendMode: "base64",
          storageIsHttps: true,
          initLimiter: unlimited,
          completeLimiter: unlimited,
          log: { warn: (message, meta) => void logs.push({ message, meta }), error: (message, meta) => void logs.push({ message, meta }) },
          ...over,
        },
        {},
      ),
    );
  }
  useMedia();
  afterEach(() => {
    fake.sent.length = 0;
    fake.state.base64 = true;
    fake.state.failNextSend = false;
    fake.state.downloadDelayMs = 0;
    mem.failWith = null;
    logs.length = 0;
    useMedia();
    vi.restoreAllMocks();
  });

  const sessions: Record<string, unknown> = {};
  const deps = {
    db,
    llm: createFakeLlm(),
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null } },
  } as unknown as Deps;
  const config = loadConversationsConfig({ CONVERSATIONS_BURST_WINDOW_MS: "0", CONVERSATIONS_BURST_MAX_WAIT_MS: "0", CONVERSATIONS_SWEEP_INTERVAL_MS: "0" });
  const rt = createConversationsRuntime(deps, { config, scheduleAiTurn: () => {}, register: false, media: createInboundMediaPort({ downloadTimeoutMs: 2000 }) });

  const app = new OpenAPIHono();
  app.route("/v1", conversationsRoutes(deps, { config, scheduleAiTurn: () => {}, register: false }));
  app.route("/v1", mediaRoutes(deps));
  app.onError(onError);

  const call = (as: string | null, method: string, path: string, body?: unknown) =>
    app.request(`/v1${path}`, {
      method,
      headers: { ...(as ? { "x-test-user": as } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
  type ErrBody = { error: { code: string; message: string } };

  // ── fixtures ──────────────────────────────────────────────────────────────
  let main: SecondOrg;
  let other: SecondOrg;
  let A = "";
  const chan = uuidv7();
  const channelOther = uuidv7();
  const contactIds: string[] = [];

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

  beforeAll(async () => {
    main = await createSecondOrg("midia", { extra: [{ key: "agente", role: "member", name: "Rafael Costa" }] });
    other = await createSecondOrg("midia-outra");
    A = main.orgId;
    sessions.owner = { user: { id: main.userId, name: main.userName, email: main.userEmail }, session: { id: "s1", activeOrganizationId: A } };
    sessions.agent = { user: { id: main.members.agente!.userId, name: "Rafael Costa", email: main.members.agente!.email }, session: { id: "s2", activeOrganizationId: A } };
    sessions.other = { user: { id: other.userId, name: other.userName, email: other.userEmail }, session: { id: "s3", activeOrganizationId: other.orgId } };
    await insertChannel(A, chan, `Recepção ${run}`);
    await insertChannel(other.orgId, channelOther, `Outra ${run}`);
  });
  afterAll(async () => {
    await main?.remove();
    await other?.remove();
  });

  // ── helpers de cenário ────────────────────────────────────────────────────
  type Msg = Extract<InboundEvent, { type: "message" }>;
  async function inbound(over: Partial<Msg> = {}, org = A, channelId = chan) {
    const event: Msg = { type: "message", externalId: extId(), from: over.from ?? phone(), name: "Cliente Teste", kind: "text", text: "oi", at: new Date().toISOString(), ...over };
    await handleInbound(rt.inbound, { organizationId: org, channelId, event });
    return event;
  }
  async function conversationOf(from: string, org = A, channelId = chan) {
    return withOrg(db, org, async (tx) => {
      const [contact] = await tx.select().from(schema.contacts).where(and(eq(schema.contacts.organizationId, org), eq(schema.contacts.phone, from)));
      if (!contact) return null;
      if (!contactIds.includes(contact.id)) contactIds.push(contact.id);
      const [conv] = await tx.select().from(schema.conversations).where(and(eq(schema.conversations.contactId, contact.id), eq(schema.conversations.channelId, channelId)));
      return conv ? { conv, contact } : null;
    });
  }
  async function newConversation() {
    const from = phone();
    await inbound({ from });
    const found = await conversationOf(from);
    if (!found) throw new Error("conversa não criada");
    return { from, ...found };
  }
  const messagesOf = (conversationId: string, org = A) => withOrg(db, org, (tx) => tx.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(schema.messages.createdAt, schema.messages.id));
  const mediaRows = (org = A) => withOrg(db, org, (tx) => tx.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.organizationId, org)));
  const keyOf = (url: string) => decodeURIComponent(new URL(url).pathname.replace(/^\/put\//, ""));

  type UploadInit = { mediaId: string; uploadUrl: string; headers: Record<string, string>; expiresAt: string };
  type Ready = { mediaId: string; kind: string; fileName: string; mimeType: string; sizeBytes: number; durationSeconds: number | null };
  const initBody = (kind: string, fileName: string, mimeType: string, sizeBytes: number, durationSeconds?: number) => ({ kind, fileName, mimeType, sizeBytes, ...(durationSeconds === undefined ? {} : { durationSeconds }) });

  /** init → "PUT" no armazenamento em memória → complete. */
  async function upload(as: string, kind: string, fileName: string, mimeType: string, bytes: Buffer, durationSeconds?: number) {
    const init = await call(as, "POST", "/media/uploads", initBody(kind, fileName, mimeType, bytes.length, durationSeconds));
    if (init.status !== 201) throw new Error(`init ${init.status}: ${JSON.stringify(await init.json())}`);
    const data = await json<UploadInit>(init);
    mem.simulatePut(keyOf(data.uploadUrl), bytes, data.headers["Content-Type"] ?? mimeType);
    const complete = await call(as, "POST", `/media/uploads/${data.mediaId}/complete`);
    return { init: data, complete, ready: complete.status === 200 ? await json<Ready>(complete) : null };
  }

  const sendBody = (kind: string, mediaId: string | null, body = "", extra: Record<string, unknown> = {}) => ({
    kind,
    body,
    attachment: mediaId ? { fileName: "ignorado.exe", mimeType: "application/x-msdownload", sizeBytes: 1, durationSeconds: null, url: null, mediaId, ...extra } : null,
    clientId: `c-${run}-${++seq}`,
  });

  type MessageBody = { id: string; kind: string; status: string; attachment: { fileName: string | null; mimeType: string; sizeBytes: number | null; durationSeconds: number | null; url: string | null; thumbnailUrl?: string | null; sticker?: boolean; mediaId: string | null } | null };
  const send = (conversationId: string, payload: unknown, as = "owner") => call(as, "POST", `/conversations/${conversationId}/messages`, payload);

  // ═══════════════════════════════════════════════════════════════════════════
  describe("sem armazenamento configurado", () => {
    it("pedir envio e mandar anexo respondem 503 com mensagem clara; texto continua funcionando", async () => {
      useMedia({ storage: null });
      const { conv } = await newConversation();
      const init = await call("owner", "POST", "/media/uploads", initBody("image", "a.png", "image/png", 1000));
      expect(init.status).toBe(503);
      const err = await json<ErrBody>(init);
      expect(err.error.code).toBe("media_unavailable");
      expect(err.error.message).toMatch(/armazenamento de mídia não foi configurado/);
      expect((await call("owner", "POST", `/media/uploads/${uuidv7()}/complete`)).status).toBe(503);

      const attach = await send(conv.id, sendBody("image", uuidv7()));
      expect(attach.status).toBe(503);
      expect((await json<ErrBody>(attach)).error.code).toBe("media_unavailable");
      expect((await messagesOf(conv.id)).filter((m) => m.direction === "out")).toHaveLength(0);

      const text = await send(conv.id, { kind: "text", body: "Olá", attachment: null, clientId: `c-${run}-t` });
      expect(text.status).toBe(201);
      expect((await json<MessageBody>(text)).status).toBe("sent");
    });

    it("mídia RECEBIDA entra com o texto e o anexo 'indisponível' (url null), sem derrubar a mensagem", async () => {
      useMedia({ storage: null });
      const from = phone();
      const ref = extId("ref");
      fake.downloads.set(ref, { bytes: JPEG, mimeType: "image/jpeg", fileName: "x.jpeg" });
      await inbound({ from, kind: "image", text: "Veja", mediaRef: ref });
      const found = await conversationOf(from);
      const [msg] = (await messagesOf(found!.conv.id)).filter((m) => m.direction === "in");
      expect(msg).toMatchObject({ kind: "image", body: "Veja" });
      expect(msg!.media).toMatchObject({ url: null, mediaId: null });
      expect(await mediaRows()).not.toContainEqual(expect.objectContaining({ messageId: msg!.id }));
    });
  });

  describe("pedido de envio (POST /media/uploads)", () => {
    it("devolve URL assinada de PUT, cabeçalhos e validade; chave sem nome de arquivo", async () => {
      const res = await call("owner", "POST", "/media/uploads", initBody("document", "Contrato Final.PDF", "application/pdf", PDF.length));
      expect(res.status).toBe(201);
      const data = await json<UploadInit>(res);
      expect(data.uploadUrl.startsWith(`${HOST}/put/org/${A}/`)).toBe(true);
      expect(data.uploadUrl).not.toMatch(/contrato/i);
      expect(data.headers).toEqual({ "Content-Type": "application/pdf" });
      expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const put = mem.presigned.at(-1)!;
      expect(put).toMatchObject({ op: "put", contentType: "application/pdf", contentLength: PDF.length, expiresInSeconds: 600 });
      const [row] = (await mediaRows()).filter((r) => r.id === data.mediaId);
      expect(row).toMatchObject({ status: "uploading", direction: "out", kind: "document", fileName: "Contrato Final.PDF", mimeType: "application/pdf", messageId: null, createdBy: main.userId });
      expect(row!.storageKey).toMatch(new RegExp(`^org/${A}/\\d{4}-\\d{2}/[0-9a-f-]{36}$`));
    });

    it("recusa extensão, tipo, tamanho e campos inválidos com 422 em português", async () => {
      const cases: [string, ReturnType<typeof initBody>][] = [
        ["extensão perigosa", initBody("document", "setup.exe", "application/pdf", 100)],
        ["dupla extensão", initBody("document", "contrato.pdf.exe", "application/pdf", 100)],
        ["tipo que não bate com a extensão", initBody("document", "a.pdf", "image/png", 100)],
        ["tipo fora da lista", initBody("image", "a.svg", "image/svg+xml", 100)],
        ["imagem acima de 10 MB", initBody("image", "a.png", "image/png", 10 * 1024 * 1024 + 1)],
        ["documento acima de 20 MB", initBody("document", "a.pdf", "application/pdf", 20 * 1024 * 1024 + 1)],
        ["áudio acima de 16 MB", initBody("audio", "a.mp3", "audio/mpeg", 16 * 1024 * 1024 + 1)],
        ["duração em documento", initBody("document", "a.pdf", "application/pdf", 100, 5)],
      ];
      for (const [label, body] of cases) {
        const res = await call("owner", "POST", "/media/uploads", body);
        expect(res.status, label).toBe(422);
        const err = await json<ErrBody>(res);
        expect(err.error.message, label).toMatch(/[a-zãé]{4}/);
        expect(err.error.code, label).toMatch(/invalid_media|validation_error/);
      }
      const bad = await call("owner", "POST", "/media/uploads", { kind: "video", fileName: "a.mp4", mimeType: "video/mp4", sizeBytes: 10 });
      expect(bad.status).toBe(422);
      expect((await json<ErrBody>(bad)).error.code).toBe("validation_error");
    });

    it("sem sessão: 401", async () => {
      expect((await call(null, "POST", "/media/uploads", initBody("image", "a.png", "image/png", 100))).status).toBe(401);
      expect((await call(null, "POST", `/media/uploads/${uuidv7()}/complete`)).status).toBe(401);
    });

    it("limite de taxa por empresa: depois da rajada, 429 com Retry-After", async () => {
      useMedia({ initLimiter: new InMemoryTokenBucket({ capacity: 2, refillPerSecond: 0.001 }) });
      const body = initBody("image", "a.png", "image/png", 100);
      expect((await call("owner", "POST", "/media/uploads", body)).status).toBe(201);
      expect((await call("agent", "POST", "/media/uploads", body)).status).toBe(201); // a empresa toda divide o balde
      const limited = await call("owner", "POST", "/media/uploads", body);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await json<ErrBody>(limited)).error.code).toBe("rate_limited");
      // outra empresa não é afetada
      expect((await call("other", "POST", "/media/uploads", body)).status).toBe(201);
    });

    it("limita os envios em andamento por empresa", async () => {
      const org = await createSecondOrg("midia-fila");
      try {
        sessions.fila = { user: { id: org.userId, name: org.userName, email: org.userEmail }, session: { id: "s9", activeOrganizationId: org.orgId } };
        const body = initBody("image", "a.png", "image/png", 100);
        for (let i = 0; i < 50; i++) expect((await call("fila", "POST", "/media/uploads", body)).status).toBe(201);
        const over = await call("fila", "POST", "/media/uploads", body);
        expect(over.status).toBe(429);
        expect((await json<ErrBody>(over)).error.code).toBe("too_many_uploads");
      } finally {
        await org.remove();
      }
    });

    it("plano expirado (envio pausado) não aceita novos arquivos", async () => {
      const past = await createSecondOrg("midia-vencida", { status: "expired", daysToEnd: -30 });
      try {
        sessions.vencida = { user: { id: past.userId, name: past.userName, email: past.userEmail }, session: { id: "s8", activeOrganizationId: past.orgId } };
        const res = await call("vencida", "POST", "/media/uploads", initBody("image", "a.png", "image/png", 100));
        expect(res.status).toBe(403);
      } finally {
        await past.remove();
      }
    });
  });

  describe("conferência (complete)", () => {
    it("arquivo íntegro vira ready e devolve o contrato", async () => {
      const { ready, init } = await upload("owner", "image", "Foto.PNG", "image/png", PNG);
      expect(ready).toEqual({ mediaId: init.mediaId, kind: "image", fileName: "Foto.PNG", mimeType: "image/png", sizeBytes: PNG.length, durationSeconds: null });
      const [row] = (await mediaRows()).filter((r) => r.id === init.mediaId);
      expect(row).toMatchObject({ status: "ready" });
      expect(row!.readyAt).not.toBeNull();
    });

    it("imagem de verdade ganha miniatura WebP leve; o balão recebe a URL dela e a original continua intacta", async () => {
      const { default: sharp } = await import("sharp");
      const photo = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 80, b: 40 } } }).png().toBuffer();
      const { conv } = await newConversation();
      const { ready, init } = await upload("owner", "image", "foto.png", "image/png", photo);
      const [row] = (await mediaRows()).filter((r) => r.id === init.mediaId);
      expect(row!.thumbKey).toBe(`${row!.storageKey}-t`);
      const thumb = mem.objects.get(row!.thumbKey!)!;
      expect(thumb.contentType).toBe("image/webp");
      expect(thumb.bytes.length).toBeLessThan(photo.length);
      const meta = await sharp(thumb.bytes).metadata();
      expect(meta).toMatchObject({ format: "webp", width: 480, height: 360 });
      expect(mem.objects.get(row!.storageKey)!.bytes.equals(photo)).toBe(true);

      await send(conv.id, sendBody("image", ready!.mediaId));
      const body = await json<{ messages: MessageBody[] }>(await call("owner", "GET", `/conversations/${conv.id}`));
      const att = body.messages.find((m) => m.attachment)!.attachment as { url: string; thumbnailUrl: string };
      expect(att.thumbnailUrl).toContain(row!.thumbKey!);
      expect(att.url).not.toContain(row!.thumbKey!);
    });

    it("imagem que não dá para reduzir fica sem miniatura (sem erro): o balão usa a original", async () => {
      const { conv } = await newConversation();
      const { ready, init } = await upload("owner", "image", "a.png", "image/png", PNG);
      expect(ready).not.toBeNull();
      const [row] = (await mediaRows()).filter((r) => r.id === init.mediaId);
      expect(row!.thumbKey).toBeNull();
      await send(conv.id, sendBody("image", ready!.mediaId));
      const body = await json<{ messages: MessageBody[] }>(await call("owner", "GET", `/conversations/${conv.id}`));
      expect(body.messages.find((m) => m.attachment)!.attachment!.thumbnailUrl ?? null).toBeNull();
    });

    it("é idempotente (repetir devolve o mesmo) e só quem pediu o envio confere", async () => {
      const { init, ready } = await upload("owner", "image", "a.png", "image/png", PNG);
      const again = await call("owner", "POST", `/media/uploads/${init.mediaId}/complete`);
      expect(again.status).toBe(200);
      expect(await json(again)).toEqual(ready);
      expect((await call("agent", "POST", `/media/uploads/${init.mediaId}/complete`)).status).toBe(404);
      expect((await call("other", "POST", `/media/uploads/${init.mediaId}/complete`)).status).toBe(404);
      expect((await call("owner", "POST", "/media/uploads/nao-e-uuid/complete")).status).toBe(404);
      expect((await call("owner", "POST", `/media/uploads/${uuidv7()}/complete`)).status).toBe(404);
    });

    it("tipo real diferente do declarado: .pdf com conteúdo de executável é recusado, apagado do armazenamento e do uso", async () => {
      const { init, complete } = await upload("owner", "document", "contrato.pdf", "application/pdf", EXE);
      expect(complete.status).toBe(422);
      const err = await json<ErrBody>(complete);
      expect(err.error.code).toBe("invalid_media");
      expect(err.error.message).toMatch(/contrato\.pdf.*não é um PDF de verdade/);
      const [row] = (await mediaRows()).filter((r) => r.id === init.mediaId);
      expect(row!.status).toBe("deleted");
      expect(mem.objects.has(row!.storageKey)).toBe(false);
      // e não dá para insistir
      expect((await call("owner", "POST", `/media/uploads/${init.mediaId}/complete`)).status).toBe(404);
    });

    it.each([
      ["imagem .png com conteúdo JPEG", "image", "a.png", "image/png", JPEG],
      ["imagem .jpg com conteúdo de texto", "image", "a.jpg", "image/jpeg", Buffer.from("isto não é imagem".repeat(20))],
      ["áudio .ogg com conteúdo de PDF", "audio", "a.ogg", "audio/ogg", PDF],
      ["planilha .xlsx com conteúdo de PDF", "document", "p.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", PDF],
      ["texto .txt com conteúdo binário", "document", "n.txt", "text/plain", Buffer.concat([Buffer.from("abc"), Buffer.alloc(300, 0)])],
    ])("recusa %s", async (_label, kind, fileName, mime, bytes) => {
      const { complete, init } = await upload("owner", kind, fileName, mime, bytes);
      expect(complete.status).toBe(422);
      const [row] = (await mediaRows()).filter((r) => r.id === init.mediaId);
      expect(row!.status).toBe("deleted");
      expect(mem.objects.has(row!.storageKey)).toBe(false);
    });

    it("tamanho enviado diferente do informado é recusado e apagado", async () => {
      const init = await json<UploadInit>(await call("owner", "POST", "/media/uploads", initBody("image", "a.png", "image/png", PNG.length)));
      mem.simulatePut(keyOf(init.uploadUrl), Buffer.concat([PNG, Buffer.alloc(50)]), "image/png");
      const res = await call("owner", "POST", `/media/uploads/${init.mediaId}/complete`);
      expect(res.status).toBe(422);
      expect((await json<ErrBody>(res)).error.message).toMatch(/tamanho/);
      const [row] = (await mediaRows()).filter((r) => r.id === init.mediaId);
      expect(mem.objects.has(row!.storageKey)).toBe(false);
    });

    it("complete sem ter enviado nada: 409 not_uploaded e dá para tentar de novo depois do PUT", async () => {
      const init = await json<UploadInit>(await call("owner", "POST", "/media/uploads", initBody("image", "a.png", "image/png", PNG.length)));
      const early = await call("owner", "POST", `/media/uploads/${init.mediaId}/complete`);
      expect(early.status).toBe(409);
      expect((await json<ErrBody>(early)).error.code).toBe("not_uploaded");
      mem.simulatePut(keyOf(init.uploadUrl), PNG, "image/png");
      expect((await call("owner", "POST", `/media/uploads/${init.mediaId}/complete`)).status).toBe(200);
    });

    it("aceita os tipos legítimos de cada categoria (webm/opus gravado no navegador, mp3, docx, csv do Windows…)", async () => {
      const cases: [string, string, string, Buffer][] = [
        ["audio", "gravacao.webm", "audio/webm;codecs=opus", WEBM],
        ["audio", "voz.ogg", "audio/ogg", OGG],
        ["audio", "musica.mp3", "audio/mpeg", Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), randomBytes(500)])],
        ["audio", "nota.m4a", "audio/mp4", Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), randomBytes(500)])],
        ["image", "f.webp", "image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 "), randomBytes(500)])],
        ["document", "r.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ZIP],
        ["document", "r.doc", "application/msword", Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), randomBytes(500)])],
        ["document", "lista.csv", "application/vnd.ms-excel", Buffer.from("nome;valor\nJoão;10\n")],
        ["document", "notas.txt", "text/plain", Buffer.from("Anotações da reunião.\n")],
      ];
      for (const [kind, name, mime, bytes] of cases) {
        const { ready, complete } = await upload("owner", kind, name, mime, bytes);
        expect(complete.status, name).toBe(200);
        expect(ready!.mimeType, name).toBe(mime.split(";")[0] === "application/vnd.ms-excel" && name.endsWith(".csv") ? "text/csv" : mime.split(";")[0]);
      }
    });
  });

  describe("envio da mensagem com anexo", () => {
    it("imagem (base64): o provedor recebe o arquivo, a legenda e o nome; a mensagem guarda só o mediaId; a URL do cliente é ignorada", async () => {
      const { conv } = await newConversation();
      const { ready } = await upload("owner", "image", "Foto da fachada.png", "image/png", PNG);
      const res = await send(conv.id, sendBody("image", ready!.mediaId, "Nossa fachada", { url: "https://evil.example/roubo.png" }));
      expect(res.status).toBe(201);
      const msg = await json<MessageBody>(res);
      expect(msg).toMatchObject({ kind: "image", status: "sent" });
      expect(msg.attachment).toMatchObject({ fileName: "Foto da fachada.png", mimeType: "image/png", sizeBytes: PNG.length, mediaId: ready!.mediaId });
      expect(msg.attachment!.url).toMatch(new RegExp(`^${HOST}/get/org/${A}/`));

      expect(fake.sent).toHaveLength(1);
      const out = fake.sent[0]!;
      // a legenda é o corpo da mensagem (com a assinatura de quem atende, como no texto: o canal de teste assina)
      expect(out).toMatchObject({ kind: "image", filename: "Foto da fachada.png", mimeType: "image/png" });
      expect(out.text).toMatch(/Nossa fachada$/);
      expect(out.mediaUrl).toBeUndefined();
      expect(Buffer.from(out.mediaBase64!, "base64").equals(PNG)).toBe(true);
      expect(JSON.stringify(fake.sent)).not.toContain("evil.example");

      const [row] = await messagesOf(conv.id).then((r) => r.filter((m) => m.id === msg.id));
      expect(row!.media).toMatchObject({ mediaId: ready!.mediaId, url: null, fileName: "Foto da fachada.png" });
      expect(JSON.stringify(row!.media)).not.toContain("evil.example");
      expect((await mediaRows()).find((r) => r.id === ready!.mediaId)!.messageId).toBe(msg.id);
      const [c] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
      expect(c).toMatchObject({ lastMessageKind: "image", lastMessageFileName: "Foto da fachada.png", lastMessageDirection: "out" });
    });

    it("documento: legenda = body da mensagem; áudio gravado (webm) chega ao provedor com tipo e duração", async () => {
      const { conv } = await newConversation();
      const doc = await upload("owner", "document", "Proposta.pdf", "application/pdf", PDF);
      const docRes = await json<MessageBody>(await send(conv.id, sendBody("document", doc.ready!.mediaId, "Segue a proposta")));
      expect(docRes.attachment).toMatchObject({ fileName: "Proposta.pdf", mimeType: "application/pdf" });
      expect(fake.sent[0]).toMatchObject({ kind: "document", filename: "Proposta.pdf", mimeType: "application/pdf" });
      expect(fake.sent[0]!.text).toMatch(/Segue a proposta$/);

      const audio = await upload("owner", "audio", "gravacao.webm", "audio/webm;codecs=opus", WEBM, 7);
      expect(audio.ready).toMatchObject({ mimeType: "audio/webm", durationSeconds: 7 });
      const audioRes = await json<MessageBody>(await send(conv.id, sendBody("audio", audio.ready!.mediaId, "legenda de áudio é ignorada")));
      expect(audioRes.attachment).toMatchObject({ mimeType: "audio/webm", durationSeconds: 7 });
      expect(fake.sent[1]).toMatchObject({ kind: "audio", mimeType: "audio/webm" });
      expect(fake.sent[1]!.text).toBeUndefined();
      expect(Buffer.from(fake.sent[1]!.mediaBase64!, "base64").equals(WEBM)).toBe(true);
      const [c] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
      expect(c).toMatchObject({ lastMessageKind: "audio", lastMessageDurationSeconds: 7 });
    });

    it("modo url: o provedor recebe uma URL assinada (https, host público) e nenhum base64", async () => {
      vi.spyOn(dnsPromises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
      useMedia({ sendMode: "url" });
      const { conv } = await newConversation();
      const { ready } = await upload("owner", "image", "a.png", "image/png", PNG);
      const res = await send(conv.id, sendBody("image", ready!.mediaId));
      expect((await json<MessageBody>(res)).status).toBe("sent");
      const out = fake.sent[0]!;
      expect(out.mediaBase64).toBeUndefined();
      expect(out.mediaUrl).toMatch(new RegExp(`^${HOST}/get/org/${A}/`));
      expect(mem.presigned.filter((p) => p.op === "get" && p.expiresInSeconds === 900)).toHaveLength(1);
    });

    it("modo auto: armazenamento https e público → URL; host que resolve para IP interno → cai para base64; sem https → base64", async () => {
      const lookup = vi.spyOn(dnsPromises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
      useMedia({ sendMode: "auto", storageIsHttps: true });
      const { conv } = await newConversation();
      const a = await upload("owner", "image", "a.png", "image/png", PNG);
      await send(conv.id, sendBody("image", a.ready!.mediaId));
      expect(fake.sent[0]!.mediaUrl).toBeDefined();
      expect(fake.sent[0]!.mediaBase64).toBeUndefined();

      lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }] as never);
      const b = await upload("owner", "image", "b.png", "image/png", PNG);
      await send(conv.id, sendBody("image", b.ready!.mediaId));
      expect(fake.sent[1]!.mediaUrl).toBeUndefined();
      expect(fake.sent[1]!.mediaBase64).toBeDefined();

      useMedia({ sendMode: "auto", storageIsHttps: false });
      const c = await upload("owner", "image", "c.png", "image/png", PNG);
      await send(conv.id, sendBody("image", c.ready!.mediaId));
      expect(fake.sent[2]!.mediaUrl).toBeUndefined();
      expect(fake.sent[2]!.mediaBase64).toBeDefined();
    });

    it("provedor sem base64 (API oficial da Meta) sempre recebe URL, mesmo com MEDIA_SEND_MODE=base64", async () => {
      vi.spyOn(dnsPromises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
      fake.state.base64 = false;
      useMedia({ sendMode: "base64" });
      const { conv } = await newConversation();
      const { ready } = await upload("owner", "document", "a.pdf", "application/pdf", PDF);
      await send(conv.id, sendBody("document", ready!.mediaId));
      expect(fake.sent[0]!.mediaUrl).toBeDefined();
      expect(fake.sent[0]!.mediaBase64).toBeUndefined();
    });

    it("mediaId inválido: sem mediaId, malformado, inexistente, de outra empresa, de outra pessoa, de outro tipo, não conferido e já usado → 422 sem efeito colateral", async () => {
      const { conv } = await newConversation();
      const mine = await upload("owner", "image", "a.png", "image/png", PNG);
      const theirs = await json<UploadInit>(await call("other", "POST", "/media/uploads", initBody("image", "o.png", "image/png", PNG.length)));
      mem.simulatePut(keyOf(theirs.uploadUrl), PNG, "image/png");
      await call("other", "POST", `/media/uploads/${theirs.mediaId}/complete`);
      const pending = await json<UploadInit>(await call("owner", "POST", "/media/uploads", initBody("image", "p.png", "image/png", PNG.length)));
      const colleague = await upload("agent", "image", "colega.png", "image/png", PNG);

      const refusals: [string, unknown][] = [
        ["sem anexo", sendBody("image", null)],
        ["sem mediaId", { ...sendBody("image", null), attachment: { fileName: "a.png", mimeType: "image/png", sizeBytes: 1, durationSeconds: null, url: "https://x.example/a.png" } }],
        ["mediaId malformado", sendBody("image", "nao-e-uuid")],
        ["mediaId inexistente", sendBody("image", uuidv7())],
        ["de outra empresa", sendBody("image", theirs.mediaId)],
        ["de outro tipo (imagem enviada como documento)", sendBody("document", mine.ready!.mediaId)],
        ["upload ainda não conferido", sendBody("image", pending.mediaId)],
        ["arquivo enviado por outra pessoa da empresa", sendBody("image", colleague.ready!.mediaId)],
      ];
      for (const [label, payload] of refusals) {
        const res = await send(conv.id, payload);
        expect(res.status, label).toBe(422);
        expect((await json<ErrBody>(res)).error.code, label).toBe("invalid_media");
      }
      expect(fake.sent).toHaveLength(0);
      expect((await messagesOf(conv.id)).filter((m) => m.direction === "out")).toHaveLength(0);
      // nada foi consumido: o mesmo arquivo ainda serve
      expect((await send(conv.id, sendBody("image", mine.ready!.mediaId))).status).toBe(201);
      // e agora ele já foi usado
      const reuse = await send(conv.id, sendBody("image", mine.ready!.mediaId));
      expect(reuse.status).toBe(422);
      expect((await json<ErrBody>(reuse)).error.message).toMatch(/já foi usado/);
      expect(fake.sent).toHaveLength(1);
    });

    it("o mesmo mediaId em duas conversas ao mesmo tempo: só uma passa", async () => {
      const [c1, c2] = [await newConversation(), await newConversation()];
      const { ready } = await upload("owner", "image", "a.png", "image/png", PNG);
      const results = await Promise.all([send(c1.conv.id, sendBody("image", ready!.mediaId)), send(c2.conv.id, sendBody("image", ready!.mediaId))]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(fake.sent).toHaveLength(1);
    });

    it("repetir o pedido com o mesmo clientId (rede instável) devolve a mesma mensagem, sem reenviar nem dar erro", async () => {
      const { conv } = await newConversation();
      const { ready } = await upload("owner", "image", "a.png", "image/png", PNG);
      const payload = sendBody("image", ready!.mediaId);
      const first = await json<MessageBody>(await send(conv.id, payload));
      const second = await send(conv.id, payload);
      expect(second.status).toBe(201);
      expect((await json<MessageBody>(second)).id).toBe(first.id);
      expect(fake.sent).toHaveLength(1);
    });

    it("falha do provedor deixa a mensagem 'failed' e o reenvio manda o MESMO arquivo", async () => {
      const { conv } = await newConversation();
      const { ready } = await upload("owner", "document", "a.pdf", "application/pdf", PDF);
      fake.state.failNextSend = true;
      const failed = await json<MessageBody & { failureReason: string }>(await send(conv.id, sendBody("document", ready!.mediaId, "Tente de novo")));
      expect(failed.status).toBe("failed");
      const retry = await call("owner", "POST", `/conversations/${conv.id}/messages/${failed.id}/resend`);
      expect(retry.status).toBe(200);
      expect((await json<MessageBody>(retry)).status).toBe("sent");
      expect(fake.sent).toHaveLength(2);
      expect(fake.sent[1]!.mediaBase64).toBe(fake.sent[0]!.mediaBase64);
      expect(fake.sent[1]).toMatchObject({ filename: "a.pdf" });
      expect(fake.sent[1]!.text).toBe(fake.sent[0]!.text);
      expect(fake.sent[1]!.text).toMatch(/Tente de novo$/);
    });

    it("armazenamento fora do ar na hora do envio: mensagem 'failed' com motivo claro (e arquivo continua nosso)", async () => {
      const { conv } = await newConversation();
      const { ready } = await upload("owner", "image", "a.png", "image/png", PNG);
      mem.failWith = new Error("conexão recusada");
      const res = await send(conv.id, sendBody("image", ready!.mediaId));
      const msg = await json<MessageBody & { failureReason: string }>(res);
      expect(msg.status).toBe("failed");
      expect(msg.failureReason).toMatch(/Não foi possível ler o arquivo/);
      expect(fake.sent).toHaveLength(0);
    });

    it("objeto trocado DEPOIS do complete (a URL de PUT ainda valia): o envio confere o tipo de novo, descarta o arquivo e não envia", async () => {
      for (const mode of ["base64", "url"] as const) {
        vi.spyOn(dnsPromises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
        useMedia({ sendMode: mode });
        const { conv } = await newConversation();
        const { ready } = await upload("owner", "document", "fatura.pdf", "application/pdf", PDF);
        const [row] = (await mediaRows()).filter((r) => r.id === ready!.mediaId);
        // o autor reaproveita a URL assinada: mesmo tamanho, mas agora é um executável
        mem.simulatePut(row!.storageKey, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(PDF.length - 2, 0)]), "application/pdf");
        const res = await send(conv.id, sendBody("document", ready!.mediaId));
        const msg = await json<MessageBody & { failureReason: string }>(res);
        expect(msg.status, mode).toBe("failed");
        expect(msg.failureReason, mode).toMatch(/foi alterado/);
        expect(fake.sent, mode).toHaveLength(0);
        expect(mem.objects.has(row!.storageKey), mode).toBe(false);
        expect((await mediaRows()).find((r) => r.id === ready!.mediaId)!.status, mode).toBe("deleted");
      }
    });

    it("conversa de outra empresa continua 404", async () => {
      const { conv } = await newConversation();
      const mineOther = await upload("other", "image", "a.png", "image/png", PNG);
      expect((await send(conv.id, sendBody("image", mineOther.ready!.mediaId), "other")).status).toBe(404);
    });
  });

  describe("leitura: URL assinada só para quem vê a conversa", () => {
    it("o dono vê a URL assinada e o mediaId; quem não alcança a conversa recebe 404 sem nenhum rastro; outra empresa também", async () => {
      const { conv } = await newConversation();
      const { ready } = await upload("owner", "image", "a.png", "image/png", PNG);
      await send(conv.id, sendBody("image", ready!.mediaId));

      const detail = await call("owner", "GET", `/conversations/${conv.id}`);
      expect(detail.status).toBe(200);
      const body = await json<{ messages: MessageBody[] }>(detail);
      const withMedia = body.messages.find((m) => m.attachment)!;
      expect(withMedia.attachment).toMatchObject({ mediaId: ready!.mediaId, fileName: "a.png" });
      expect(withMedia.attachment!.url).toMatch(new RegExp(`^${HOST}/get/org/${A}/`));
      expect(mem.presigned.filter((p) => p.op === "get").at(-1)).toMatchObject({ expiresInSeconds: 600, contentType: "image/png" });

      // a conversa é do dono (respondeu = assumiu): o atendente de outra equipe não alcança
      for (const as of ["agent", "other"]) {
        const res = await call(as, "GET", `/conversations/${conv.id}`);
        expect(res.status, as).toBe(404);
        expect(JSON.stringify(await res.json()), as).not.toContain(HOST);
      }
    });

    it("documento sai como download (attachment) e áudio/imagem inline", async () => {
      const { conv } = await newConversation();
      const doc = await upload("owner", "document", "Orçamento 2026.pdf", "application/pdf", PDF);
      await send(conv.id, sendBody("document", doc.ready!.mediaId));
      const img = await upload("owner", "image", "a.png", "image/png", PNG);
      await send(conv.id, sendBody("image", img.ready!.mediaId));
      await call("owner", "GET", `/conversations/${conv.id}`);
      const gets = mem.presigned.filter((p) => p.op === "get").slice(-2);
      expect(gets.find((g) => g.contentType === "application/pdf")).toMatchObject({ attachment: true, fileName: "Orçamento 2026.pdf" });
      expect(gets.find((g) => g.contentType === "image/png")).toMatchObject({ attachment: false });
    });

    it("sem armazenamento, falha ao assinar ou arquivo apagado: url null (a mensagem continua visível); JSON antigo com url do cliente nunca vaza", async () => {
      const { conv } = await newConversation();
      const { ready } = await upload("owner", "image", "a.png", "image/png", PNG);
      await send(conv.id, sendBody("image", ready!.mediaId));
      // mensagem antiga (do tempo do placeholder) com URL do cliente dentro do JSON
      await withOrg(db, A, (tx) =>
        tx.insert(schema.messages).values({
          id: uuidv7(), organizationId: A, conversationId: conv.id, channelId: chan, direction: "out", kind: "image", status: "failed", body: "",
          media: { fileName: "antigo.png", mimeType: "image/png", sizeBytes: 1, durationSeconds: null, url: "https://evil.example/antigo.png" },
          senderKind: "member", senderId: main.userId, senderName: "Marina",
        }),
      );
      const urls = async () => (await json<{ messages: MessageBody[] }>(await call("owner", "GET", `/conversations/${conv.id}`))).messages.flatMap((m) => (m.attachment ? [m.attachment] : []));

      expect((await urls()).every((a) => a.url === null || a.url.startsWith(HOST))).toBe(true);
      expect(JSON.stringify(await urls())).not.toContain("evil.example");

      useMedia({ storage: null });
      expect((await urls()).map((a) => a.url)).toEqual([null, null]);

      useMedia();
      mem.failWith = new Error("fora do ar");
      expect((await urls()).map((a) => a.url)).toEqual([null, null]);
      mem.failWith = null;

      await withOrg(db, A, (tx) => tx.update(schema.mediaFiles).set({ status: "deleted" }).where(eq(schema.mediaFiles.id, ready!.mediaId)));
      const after = await urls();
      expect(after.every((a) => a.url === null)).toBe(true);
      expect(after.find((a) => a.mediaId === ready!.mediaId)).toBeDefined();
    });
  });

  describe("mídia recebida", () => {
    it("imagem, áudio e documento são baixados, conferidos, guardados e anexados à mensagem", async () => {
      const from = phone();
      const cases: { kind: "image" | "audio" | "document"; ref: string; media: DownloadedMedia; caption?: string; expectName: string; expectMime: string }[] = [
        { kind: "image", ref: extId("img"), media: { bytes: JPEG, mimeType: "image/jpeg", fileName: "3EB0ABC.jpeg" }, caption: "Minha receita", expectName: "3EB0ABC.jpeg", expectMime: "image/jpeg" },
        { kind: "audio", ref: extId("aud"), media: { bytes: OGG, mimeType: "audio/ogg; codecs=opus", fileName: undefined }, expectName: "audio.ogg", expectMime: "audio/ogg" },
        { kind: "document", ref: extId("doc"), media: { bytes: PDF, mimeType: "application/pdf", fileName: "Exame de sangue.pdf" }, caption: "Resultado", expectName: "Exame de sangue.pdf", expectMime: "application/pdf" },
      ];
      for (const c of cases) {
        fake.downloads.set(c.ref, c.media);
        await inbound({ from, kind: c.kind, text: c.caption, mediaRef: c.ref, externalId: c.ref });
      }
      const found = await conversationOf(from);
      const msgs = (await messagesOf(found!.conv.id)).filter((m) => m.direction === "in");
      expect(msgs.map((m) => m.kind)).toEqual(["image", "audio", "document"]);
      const rows = await mediaRows();
      for (const [i, c] of cases.entries()) {
        const m = msgs[i]!;
        const row = rows.find((r) => r.messageId === m.id)!;
        expect(row, c.kind).toMatchObject({ status: "ready", direction: "in", kind: c.kind, fileName: c.expectName, mimeType: c.expectMime, sizeBytes: c.media.bytes.length, createdBy: null });
        expect(row.storageKey).toMatch(new RegExp(`^org/${A}/\\d{4}-\\d{2}/[0-9a-f-]{36}$`));
        expect(mem.objects.get(row.storageKey)!.bytes.equals(c.media.bytes)).toBe(true);
        expect(mem.objects.get(row.storageKey)!.contentType).toBe(c.expectMime);
        expect(m.media).toMatchObject({ mediaId: row.id, fileName: c.expectName, mimeType: c.expectMime, url: null, mediaRef: c.ref });
        expect(m.body).toBe(c.caption ?? "");
      }
      expect(found!.conv).toMatchObject({ lastMessageKind: "document", lastMessageFileName: "Exame de sangue.pdf", unreadCount: 3 });
      // leitura: o atendente vê a URL assinada
      const detail = await json<{ messages: MessageBody[] }>(await call("owner", "GET", `/conversations/${found!.conv.id}`));
      const urls = detail.messages.flatMap((m) => (m.attachment ? [m.attachment] : []));
      expect(urls).toHaveLength(3);
      expect(urls.every((a) => a.url?.startsWith(`${HOST}/get/org/${A}/`) && a.mediaId)).toBe(true);
    });

    it("figurinha vira imagem marcada como figurinha, guardada sem miniatura, e a leitura devolve a marca", async () => {
      const { default: sharp } = await import("sharp");
      const webp = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer();
      const from = phone();
      const ref = extId("stk");
      fake.downloads.set(ref, { bytes: webp, mimeType: "image/webp", fileName: undefined });
      await inbound({ from, kind: "image", sticker: true, mediaRef: ref, externalId: ref, text: undefined });
      const found = await conversationOf(from);
      const [msg] = (await messagesOf(found!.conv.id)).filter((m) => m.direction === "in");
      expect(msg).toMatchObject({ kind: "image", body: "" });
      expect(msg!.media).toMatchObject({ sticker: true, mimeType: "image/webp" });
      const [row] = (await mediaRows()).filter((r) => r.messageId === msg!.id);
      expect(row).toMatchObject({ kind: "image", status: "ready", thumbKey: null });
      const detail = await json<{ messages: MessageBody[] }>(await call("owner", "GET", `/conversations/${found!.conv.id}`));
      expect(detail.messages.find((m) => m.attachment)!.attachment).toMatchObject({ sticker: true, thumbnailUrl: null });
    });

    it("falha ao baixar NUNCA perde a mensagem: entra com a legenda e o anexo indisponível", async () => {
      const from = phone();
      const ref = extId("falha");
      fake.downloads.set(ref, new ProviderError("unavailable", "fora do ar"));
      await inbound({ from, kind: "document", text: "Contrato assinado", mediaRef: ref, externalId: ref });
      const found = await conversationOf(from);
      const [msg] = (await messagesOf(found!.conv.id)).filter((m) => m.direction === "in");
      expect(msg).toMatchObject({ kind: "document", body: "Contrato assinado" });
      expect(msg!.media).toMatchObject({ url: null, mediaId: null, mediaRef: ref });
      expect(found!.conv.unreadCount).toBe(1);
      expect(logs.some((l) => l.message === "media.inbound.download_failed")).toBe(true);
      // a leitura mostra o anexo sem URL
      const detail = await json<{ messages: MessageBody[] }>(await call("owner", "GET", `/conversations/${found!.conv.id}`));
      expect(detail.messages.find((m) => m.attachment)!.attachment).toMatchObject({ url: null, mediaId: null });
    });

    it("falha ao GUARDAR no armazenamento também não perde a mensagem", async () => {
      const from = phone();
      const ref = extId("put");
      fake.downloads.set(ref, { bytes: JPEG, mimeType: "image/jpeg", fileName: "a.jpg" });
      mem.failWith = new Error("armazenamento fora do ar");
      await inbound({ from, kind: "image", mediaRef: ref, externalId: ref });
      mem.failWith = null;
      const found = await conversationOf(from);
      const [msg] = (await messagesOf(found!.conv.id)).filter((m) => m.direction === "in");
      expect(msg).toMatchObject({ kind: "image" });
      expect(msg!.media).toMatchObject({ url: null, mediaId: null });
      expect((await mediaRows()).filter((r) => r.messageId === msg!.id)).toHaveLength(0);
    });

    it("tipo fora de MEDIA_RULES, conteúdo diferente do tipo e arquivo grande demais viram 'arquivo não suportado', sem guardar nada", async () => {
      const from = phone();
      const before = (await mediaRows()).length;
      const cases: [string, "image" | "audio" | "document", DownloadedMedia, string | undefined][] = [
        ["zip", "document", { bytes: ZIP, mimeType: "application/zip", fileName: "pacote.zip" }, "Segue"],
        ["exe com nome de pdf", "document", { bytes: EXE, mimeType: "application/pdf", fileName: "fatura.pdf" }, undefined],
        ["imagem que é executável", "image", { bytes: EXE, mimeType: "image/jpeg", fileName: "foto.jpg" }, undefined],
        ["vazio", "image", { bytes: Buffer.alloc(0), mimeType: "image/png", fileName: "a.png" }, undefined],
        ["26 MB", "document", { bytes: Buffer.concat([PDF, Buffer.alloc(MAX_INBOUND_BYTES)]), mimeType: "application/pdf", fileName: "enorme.pdf" }, undefined],
      ];
      for (const [label, kind, media, caption] of cases) {
        const ref = extId(label.slice(0, 3));
        fake.downloads.set(ref, media);
        await inbound({ from, kind, text: caption, mediaRef: ref, externalId: ref });
      }
      const found = await conversationOf(from);
      const msgs = (await messagesOf(found!.conv.id)).filter((m) => m.direction === "in");
      expect(msgs).toHaveLength(cases.length);
      for (const m of msgs) {
        expect(m.kind).toBe("text");
        expect(m.body).toContain("[arquivo não suportado]");
        expect(m.media).toBeNull();
      }
      expect(msgs[0]!.body).toBe("Segue\n[arquivo não suportado]");
      expect((await mediaRows()).length).toBe(before);
      expect([...mem.objects.keys()].every((k) => !k.includes("pacote"))).toBe(true);
    });

    it("webhook repetido não duplica mensagem, registro nem objeto, e nem baixa de novo", async () => {
      const from = phone();
      const ref = extId("rep");
      fake.downloads.set(ref, { bytes: PNG, mimeType: "image/png", fileName: "a.png" });
      fake.downloadCalls.length = 0;
      const objectsBefore = mem.objects.size;
      const event = await inbound({ from, kind: "image", mediaRef: ref, externalId: ref });
      await handleInbound(rt.inbound, { organizationId: A, channelId: chan, event });
      await handleInbound(rt.inbound, { organizationId: A, channelId: chan, event });
      const found = await conversationOf(from);
      expect((await messagesOf(found!.conv.id)).filter((m) => m.direction === "in")).toHaveLength(1);
      expect(fake.downloadCalls).toEqual([ref]);
      expect(mem.objects.size).toBe(objectsBefore + 1);
      const mine = (await mediaRows()).filter((r) => r.direction === "in" && r.messageId && mem.objects.get(r.storageKey)?.bytes.equals(PNG));
      expect(mine.filter((r) => (r.messageId ? true : false)).length).toBeGreaterThanOrEqual(1);
      const own = (await messagesOf(found!.conv.id)).find((m) => m.direction === "in")!;
      expect((await mediaRows()).filter((r) => r.messageId === own.id)).toHaveLength(1);
    });

    it("duas entregas SIMULTÂNEAS do mesmo evento: uma mensagem, um arquivo (o excedente é descartado)", async () => {
      const from = phone();
      const ref = extId("sim");
      fake.downloads.set(ref, { bytes: PNG, mimeType: "image/png", fileName: "simultanea.png" });
      fake.state.downloadDelayMs = 50;
      const objectsBefore = mem.objects.size;
      const event: Msg = { type: "message", externalId: ref, from, kind: "image", at: new Date().toISOString(), mediaRef: ref };
      await Promise.all([handleInbound(rt.inbound, { organizationId: A, channelId: chan, event }), handleInbound(rt.inbound, { organizationId: A, channelId: chan, event })]);
      const found = await conversationOf(from);
      const msgs = (await messagesOf(found!.conv.id)).filter((m) => m.direction === "in");
      expect(msgs).toHaveLength(1);
      expect((await mediaRows()).filter((r) => r.fileName === "simultanea.png")).toHaveLength(1);
      expect(mem.objects.size).toBe(objectsBefore + 1);
    });

    it("texto continua como sempre (sem download, sem registro)", async () => {
      fake.downloadCalls.length = 0;
      const before = (await mediaRows()).length;
      await inbound({ text: "só texto" });
      expect(fake.downloadCalls).toHaveLength(0);
      expect((await mediaRows()).length).toBe(before);
    });
  });

  describe("limpeza oportunista", () => {
    it("o próximo pedido de envio apaga `uploading` com mais de 1 h (objeto e registro), mas não os recentes", async () => {
      const oldId = uuidv7();
      const oldKey = `org/${A}/2025-01/${uuidv7()}`;
      const freshInit = await json<UploadInit>(await call("owner", "POST", "/media/uploads", initBody("image", "recente.png", "image/png", 10)));
      mem.simulatePut(oldKey, PNG, "image/png");
      await withOrg(db, A, (tx) =>
        tx.insert(schema.mediaFiles).values({
          id: oldId, organizationId: A, kind: "image", fileName: "velho.png", mimeType: "image/png", sizeBytes: PNG.length, storageKey: oldKey,
          status: "uploading", direction: "out", createdBy: main.userId, createdAt: new Date(Date.now() - 2 * 3_600_000),
        }),
      );
      await call("owner", "POST", "/media/uploads", initBody("image", "gatilho.png", "image/png", 10));
      const ids = (await mediaRows()).map((r) => r.id);
      expect(ids).not.toContain(oldId);
      expect(ids).toContain(freshInit.mediaId);
      expect(mem.objects.has(oldKey)).toBe(false);
    });

    it("`ready` enviado e nunca usado só some depois de 24 h; recebido sem mensagem some em 1 h", async () => {
      const mk = async (direction: "in" | "out", ageHours: number) => {
        const id = uuidv7();
        const key = `org/${A}/2025-01/${uuidv7()}`;
        mem.simulatePut(key, PNG, "image/png");
        await withOrg(db, A, (tx) =>
          tx.insert(schema.mediaFiles).values({
            id, organizationId: A, kind: "image", fileName: "x.png", mimeType: "image/png", sizeBytes: PNG.length, storageKey: key,
            status: "ready", direction, createdBy: direction === "out" ? main.userId : null, createdAt: new Date(Date.now() - ageHours * 3_600_000), readyAt: new Date(),
          }),
        );
        return { id, key };
      };
      const outTwoHours = await mk("out", 2);
      const inTwoHours = await mk("in", 2);
      const outTwoDays = await mk("out", 48);
      await call("owner", "POST", "/media/uploads", initBody("image", "gatilho.png", "image/png", 10));
      const ids = (await mediaRows()).map((r) => r.id);
      expect(ids).toContain(outTwoHours.id);
      expect(ids).not.toContain(inTwoHours.id);
      expect(ids).not.toContain(outTwoDays.id);
      expect(mem.objects.has(inTwoHours.key)).toBe(false);
      expect(mem.objects.has(outTwoDays.key)).toBe(false);
      expect(mem.objects.has(outTwoHours.key)).toBe(true);
    });

    it("falha na limpeza nunca derruba o pedido", async () => {
      const key = `org/${A}/2025-01/${uuidv7()}`;
      await withOrg(db, A, (tx) =>
        tx.insert(schema.mediaFiles).values({
          id: uuidv7(), organizationId: A, kind: "image", fileName: "v.png", mimeType: "image/png", sizeBytes: 1, storageKey: key,
          status: "uploading", direction: "out", createdBy: main.userId, createdAt: new Date(Date.now() - 3 * 3_600_000),
        }),
      );
      const original = mem.deleteMany.bind(mem);
      mem.deleteMany = async () => {
        throw new Error("falha ao apagar");
      };
      const res = await call("owner", "POST", "/media/uploads", initBody("image", "ok.png", "image/png", 10));
      mem.deleteMany = original;
      expect(res.status).toBe(201);
      expect(logs.some((l) => l.message === "media.cleanup_failed")).toBe(true);
    });
  });

  describe("LGPD: exclusão do contato", () => {
    const ctx = () => ({ organizationId: A, userId: main.userId, userName: "Marina Alves", timeZone: "America/Sao_Paulo", orgName: "x" });

    it("apaga os objetos e os registros dos arquivos enviados e recebidos; os de outro contato ficam", async () => {
      const mine = await newConversation();
      const bystander = await newConversation();
      const out = await upload("owner", "image", "enviada.png", "image/png", PNG);
      await send(mine.conv.id, sendBody("image", out.ready!.mediaId));
      const ref = extId("lgpd");
      fake.downloads.set(ref, { bytes: PDF, mimeType: "application/pdf", fileName: "recebido.pdf" });
      await inbound({ from: mine.from, kind: "document", mediaRef: ref, externalId: ref });
      const byOut = await upload("owner", "image", "outra-pessoa.png", "image/png", PNG);
      await send(bystander.conv.id, sendBody("image", byOut.ready!.mediaId));

      const rows = await mediaRows();
      const mineRows = rows.filter((r) => r.fileName === "enviada.png" || r.fileName === "recebido.pdf");
      expect(mineRows).toHaveLength(2);
      const mineKeys = mineRows.map((r) => r.storageKey);
      const keepKey = rows.find((r) => r.id === byOut.ready!.mediaId)!.storageKey;
      expect(mineKeys.every((k) => mem.objects.has(k))).toBe(true);

      await withOrg(db, A, async (tx) => {
        await eraseConversationData(tx, A, [mine.contact.id]);
        await deleteContacts(tx, ctx(), [mine.contact.id]);
      });
      expect(mineKeys.some((k) => mem.objects.has(k))).toBe(false);
      const after = await mediaRows();
      expect(after.some((r) => mineKeys.includes(r.storageKey))).toBe(false);
      expect(mem.objects.has(keepKey)).toBe(true);
      expect(after.some((r) => r.id === byOut.ready!.mediaId)).toBe(true);
    });

    it("se o armazenamento recusar apagar, a exclusão inteira falha (nada fica pela metade)", async () => {
      const mine = await newConversation();
      const out = await upload("owner", "image", "sensivel.png", "image/png", PNG);
      await send(mine.conv.id, sendBody("image", out.ready!.mediaId));
      const keptKey = (await mediaRows()).find((r) => r.id === out.ready!.mediaId)!.storageKey;
      mem.failWith = new Error("armazenamento fora do ar");
      await expect(
        withOrg(db, A, async (tx) => {
          await eraseConversationData(tx, A, [mine.contact.id]);
          await deleteContacts(tx, ctx(), [mine.contact.id]);
        }),
      ).rejects.toThrow();
      mem.failWith = null;
      expect((await withOrg(db, A, (tx) => tx.select().from(schema.contacts).where(eq(schema.contacts.id, mine.contact.id)))).length).toBe(1);
      expect((await mediaRows()).some((r) => r.id === out.ready!.mediaId)).toBe(true);
      expect(mem.objects.has(keptKey)).toBe(true);
    });
  });

  describe("isolamento entre empresas (RLS)", () => {
    it("a outra empresa não enxerga nem altera os arquivos desta", async () => {
      const { ready } = await upload("owner", "image", "privada.png", "image/png", PNG);
      expect(await withOrg(db, other.orgId, (tx) => tx.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, ready!.mediaId)))).toHaveLength(0);
      const upd = await withOrg(db, other.orgId, (tx) => tx.update(schema.mediaFiles).set({ status: "deleted" }).where(eq(schema.mediaFiles.id, ready!.mediaId)).returning());
      expect(upd).toHaveLength(0);
      await expect(
        withOrg(db, other.orgId, (tx) =>
          tx.insert(schema.mediaFiles).values({ id: uuidv7(), organizationId: A, kind: "image", fileName: "x.png", mimeType: "image/png", sizeBytes: 1, storageKey: `org/${A}/x/${uuidv7()}`, direction: "out" }),
        ),
      ).rejects.toThrow();
    });
  });
});
