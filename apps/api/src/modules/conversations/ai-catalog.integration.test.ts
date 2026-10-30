import type { GenerateRequest, GenerateResult, LLMProvider } from "@duckzap/ai";
import { createDb, schema, withOrg } from "@duckzap/db";
import { and, eq, inArray } from "drizzle-orm";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../../lib/context";
import { encryptSecret } from "../../lib/crypto";
import type { InboundEvent, MessagingProvider, OutboundMessage } from "../../lib/messaging";
import { MemoryObjectStorage } from "../../lib/storage";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { loadChannelsConfig } from "../channels/config";
import { InMemoryTokenBucket } from "../channels/rate-limit";
import { createChannelsRuntime, setChannelsRuntime } from "../channels/runtime";
import { createMediaRuntime, setMediaRuntime } from "../media/runtime";
import { runDueAiTurn } from "./ai-turn";
import { createCatalogPort, pickProductPhotos, sendProductPhotos } from "./catalog-port";
import { loadConversationsConfig } from "./config";
import { handleInbound } from "./inbound";
import { createConversationsRuntime } from "./runtime";

/**
 * INTEGRAÇÃO — catálogo na IA: busca aproximada, confirmação, foto (cópia ligada à mensagem), interesse de compra como nota
 * interna + equipe chamada, produto indisponível e isolamento entre empresas. Postgres real (banco descartável), LLM
 * roteirizado, armazenamento em memória:
 *
 *   CONVERSATIONS_INTEGRATION=1 DATABASE_URL=… DATABASE_ADMIN_URL=… npx vitest run src/modules/conversations/ai-catalog
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

/** Bytes que passam na conferência de tipo (assinatura de JPEG). */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`catalog-${run}`), Buffer.alloc(64, 7)]);
const THUMB = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPthumb"), Buffer.alloc(16, 3)]);

type Step = Partial<GenerateResult> | string;
const call = (name: string, input: Record<string, unknown>, id = `c_${name}`): Step => ({ toolCalls: [{ id, name, input }], stopReason: "tool_use" });

describe.skipIf(!enabled)("IA com catálogo (integração)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 4 });
  afterAll(close);

  // ── canal e IA roteirizados ───────────────────────────────────────────────
  const sentToCustomer: OutboundMessage[] = [];
  const provider: MessagingProvider = {
    kind: "evolution",
    capabilities: () => ({ buttons: false, lists: false, templates: false, media: true, reactions: false, window24h: false, presence: false, mediaBase64: true }),
    connect: async () => ({ status: "connected" }),
    disconnect: async () => {},
    status: async () => "connected",
    send: async (_channel, message) => {
      sentToCustomer.push(message);
      return { ok: true, providerMessageId: `prov-${run}-${++seq}` };
    },
    verifyWebhook: async () => true,
    parseWebhook: async () => [],
  };
  setChannelsRuntime(
    createChannelsRuntime({
      config: loadChannelsConfig({ CHANNELS_SEND_BURST_QR: "100", CHANNELS_SEND_PER_SECOND_QR: "100" }),
      providers: { get: () => provider, kinds: () => ["evolution"] },
      sendLimiterFor: () => new InMemoryTokenBucket({ capacity: 1000, refillPerSecond: 1000 }),
    }),
  );

  const mem = new MemoryObjectStorage("https://media.test");
  const logs: { message: string; meta?: unknown }[] = [];
  const unlimited = { take: async () => ({ allowed: true, retryAfterMs: 0 }) };
  const useMedia = (over: Parameters<typeof createMediaRuntime>[0] = {}) =>
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
  useMedia();

  const llmState = { script: [] as Step[], requests: [] as GenerateRequest[], intent: "question" };
  const llm: LLMProvider = {
    name: "roteirizado",
    async generate(request: GenerateRequest) {
      llmState.requests.push(request);
      const base = { text: "", toolCalls: [], stopReason: "end" as const, usage: { inputTokens: 10, outputTokens: 5 }, model: "roteirizado", provider: "roteirizado" };
      if (request.meta?.purpose === "agent_router") return { ...base, text: JSON.stringify({ intent: llmState.intent, confidence: 0.9 }) };
      const step = llmState.script.shift();
      if (step === undefined) throw new Error("o modelo foi chamado além do roteiro");
      return { ...base, ...(typeof step === "string" ? { text: step } : step) };
    },
  };
  const smartRequests = () => llmState.requests.filter((r) => r.meta?.purpose !== "agent_router");
  /** Saídas das ferramentas que o modelo recebeu, na ordem. */
  const toolOutputs = (): string[] => {
    const out: string[] = [];
    for (const message of smartRequests().flatMap((r) => r.messages)) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) if (part.type === "tool_result") out.push(part.output);
    }
    return out;
  };

  const clock = { t: Date.now() };
  const now = () => new Date(clock.t);
  const config = loadConversationsConfig({ CONVERSATIONS_BURST_WINDOW_MS: "0", CONVERSATIONS_BURST_MAX_WAIT_MS: "0", CONVERSATIONS_SWEEP_INTERVAL_MS: "0" });
  const deps = { db, llm } as unknown as Deps;
  const rt = createConversationsRuntime(deps, { config, now, scheduleAiTurn: () => {}, register: false });
  rt.ai.sleep = async () => {};
  rt.ai.log = { warn: (message, meta) => void logs.push({ message, meta }), error: (message, meta) => void logs.push({ message, meta }) };

  // ── fixtures: empresa A (com catálogo) e empresa B (outra) ────────────────
  let orgA: SecondOrg;
  let orgB: SecondOrg;
  let A = "";
  let B = "";
  const ids = { chan: uuidv7(), agent: uuidv7(), pG: uuidv7(), pM: uuidv7(), pOff: uuidv7(), pB: uuidv7() };
  const originalKey: Record<string, string> = {};

  async function addProduct(org: string, userId: string, p: { id: string; name: string; priceCents: number | null; description: string; available?: boolean; photos?: number }) {
    await withOrg(db, org, async (tx) => {
      await tx.insert(schema.products).values({ id: p.id, organizationId: org, name: p.name, description: p.description, priceCents: p.priceCents, available: p.available ?? true });
      for (let position = 0; position < (p.photos ?? 0); position++) {
        const mediaId = uuidv7();
        const storageKey = `org/${org}/2026-10/${uuidv7()}`;
        const thumbKey = `${storageKey}-t`;
        mem.simulatePut(storageKey, JPEG, "image/jpeg");
        mem.simulatePut(thumbKey, THUMB, "image/webp");
        if (position === 0) originalKey[p.id] = storageKey;
        await tx.insert(schema.mediaFiles).values({
          id: mediaId,
          organizationId: org,
          kind: "image",
          fileName: "foto.jpg",
          mimeType: "image/jpeg",
          sizeBytes: JPEG.length,
          storageKey,
          thumbKey,
          status: "ready",
          direction: "out",
          createdBy: userId,
          readyAt: new Date(),
        });
        await tx.insert(schema.productImages).values({ id: uuidv7(), organizationId: org, productId: p.id, mediaId, position });
      }
    });
  }

  beforeAll(async () => {
    orgA = await createSecondOrg("catai", { planSlug: "empresarial" });
    orgB = await createSecondOrg("catai_b", { planSlug: "empresarial" });
    A = orgA.orgId;
    B = orgB.orgId;
    await withOrg(db, A, async (tx) => {
      await tx.insert(schema.channels).values({
        id: ids.chan,
        organizationId: A,
        name: `Canal ${run}`,
        type: "whatsapp_qr",
        provider: "evolution",
        status: "connected",
        address: "+556733330000",
        webhookTokenHash: createHash("sha256").update(randomBytes(16)).digest("hex"),
        webhookTokenEnc: encryptSecret(A, "token"),
      });
      await tx.insert(schema.agents).values({ id: ids.agent, organizationId: A, job: "support", status: "active", currentVersion: 1 });
      await tx.update(schema.channels).set({ agentId: ids.agent }).where(eq(schema.channels.id, ids.chan));
      await tx.insert(schema.agentVersions).values({
        id: uuidv7(),
        organizationId: A,
        agentId: ids.agent,
        number: 1,
        summary: "teste",
        createdBy: orgA.userId,
        config: {
          name: "Agente Duck",
          profile: { description: "Atende a loja", tone: "friendly", companySummary: "Loja Alvorada" },
          knowledge: { productsAndServices: "Vendemos roupas e acessórios.", faq: "Atendemos de segunda a sábado." },
          behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 6 },
          followUp: { enabled: false, steps: [], respectBusinessHours: true, stopOnReply: true },
          scheduling: { canBook: false, appointmentTypeIds: [] },
          advanced: { prompt: "", tools: ["search_knowledge", "request_human"] },
        },
      });
    });
    await addProduct(A, orgA.userId, { id: ids.pG, name: "Camiseta Preta G", priceCents: 5990, description: "Algodão, tamanho G.", photos: 2 });
    await addProduct(A, orgA.userId, { id: ids.pM, name: "Camiseta Preta M", priceCents: 5990, description: "Algodão, tamanho M." });
    await addProduct(A, orgA.userId, { id: ids.pOff, name: "Vestido Azul Longo", priceCents: 12990, description: "Vestido de festa.", available: false, photos: 1 });
    await addProduct(B, orgB.userId, { id: ids.pB, name: "Camiseta Secreta Roxa", priceCents: 99900, description: "Só da outra empresa.", photos: 1 });
  });
  afterAll(async () => {
    setMediaRuntime(undefined);
    await orgA?.remove();
    await orgB?.remove();
  });
  afterEach(() => {
    sentToCustomer.length = 0;
    logs.length = 0;
    llmState.script = [];
    llmState.requests = [];
    llmState.intent = "question";
    mem.failWith = null;
    useMedia();
  });

  async function inbound(from: string, text: string) {
    const event: InboundEvent = { type: "message", externalId: `ext-${run}-${++seq}`, from, name: "Cliente Teste", kind: "text", text, at: now().toISOString() };
    await handleInbound(rt.inbound, { organizationId: A, channelId: ids.chan, event });
  }
  const convOf = async (from: string) =>
    withOrg(db, A, async (tx) => {
      const [contact] = await tx.select().from(schema.contacts).where(and(eq(schema.contacts.organizationId, A), eq(schema.contacts.phone, from)));
      const [conv] = await tx.select().from(schema.conversations).where(eq(schema.conversations.contactId, contact!.id));
      return conv!;
    });
  const messagesOf = (conversationId: string) =>
    withOrg(db, A, (tx) => tx.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(schema.messages.createdAt, schema.messages.id));
  async function turn(text: string, script: Step[]) {
    llmState.script = script;
    const from = phone();
    await inbound(from, text);
    const conv = await convOf(from);
    const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
    return { from, conv, report };
  }

  it("busca → confirma o produto → manda a foto: texto primeiro, depois a imagem (uma cópia ligada à mensagem)", async () => {
    const { conv, report } = await turn("Tem camiseta preta G? Manda a foto", [
      call("search_products", { query: "camiseta preta g" }),
      call("send_product_photos", { product_id: ids.pG }, "c2"),
      "Temos sim! A Camiseta Preta G sai por R$ 59,90. Te mando a foto aqui.",
    ]);
    expect(report.result?.handoff).toBeNull();
    expect(report.sent).toBe(3);

    // o modelo recebeu as três ferramentas e viu o produto certo com o valor do catálogo
    const names = smartRequests()[0]!.tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_products", "send_product_photos", "register_interest"]));
    expect(toolOutputs()[0]).toContain(`product_id=${ids.pG} | Camiseta Preta G | R$ 59,90 | 2 fotos | confiança ALTA`);

    // o cliente recebe o texto e DEPOIS as imagens do produto (2 fotos); só a primeira leva legenda (nome e valor do catálogo)
    expect(sentToCustomer.map((m) => m.kind)).toEqual(["text", "image", "image"]);
    expect(sentToCustomer[1]).toMatchObject({ kind: "image", text: "Camiseta Preta G — R$ 59,90" });
    expect(sentToCustomer[2]?.text ?? "").toBe("");
    expect(Buffer.from(sentToCustomer[1]!.mediaBase64 ?? "", "base64").equals(JPEG)).toBe(true);

    // a mensagem de imagem é do agente e dona de uma CÓPIA do arquivo (o original do catálogo segue intacto)
    const images = (await messagesOf(conv.id)).filter((m) => m.kind === "image");
    expect(images).toHaveLength(2);
    const image = images[0];
    expect(image).toMatchObject({ direction: "out", senderKind: "agent", status: "sent", body: "Camiseta Preta G — R$ 59,90" });
    const [copy] = await withOrg(db, A, (tx) => tx.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.messageId, image!.id)));
    expect(copy).toMatchObject({ kind: "image", status: "ready", direction: "out", createdBy: null });
    expect(copy!.storageKey).not.toBe(originalKey[ids.pG]);
    expect(mem.objects.get(copy!.storageKey)!.bytes.equals(JPEG)).toBe(true);
    expect(copy!.thumbKey).toBe(`${copy!.storageKey}-t`);
    expect(mem.objects.get(copy!.thumbKey!)!.bytes.equals(THUMB)).toBe(true);
    expect(mem.objects.has(originalKey[ids.pG]!)).toBe(true);
  });

  it("erro de digitação: o modelo recebe a ordem de CONFIRMAR antes de seguir", async () => {
    await turn("tem camizeta preta g?", [call("search_products", { query: "camizeta preta g" }), "Você quis dizer a Camiseta Preta G? Ela sai por R$ 59,90."]);
    expect(toolOutputs()[0]).toMatch(/CONFIRME com o cliente \("Você quis dizer Camiseta Preta G\?"\)/);
  });

  it("variantes parecidas: manda perguntar qual (M ou G)", async () => {
    await turn("quero uma camiseta preta", [call("search_products", { query: "camiseta preta" }), "Temos a Camiseta Preta M e a Camiseta Preta G. Qual você prefere?"]);
    const out = toolOutputs()[0]!;
    expect(out).toMatch(/QUAL deles/);
    expect(out).toContain("Camiseta Preta M");
    expect(out).toContain("Camiseta Preta G");
  });

  it("produto sem fotos: nenhuma imagem sai e o turno segue", async () => {
    const { report } = await turn("manda foto da camiseta preta M", [
      call("search_products", { query: "camiseta preta m" }),
      call("send_product_photos", { product_id: ids.pM }, "c2"),
      "Essa não tem foto aqui, mas é de algodão, tamanho M.",
    ]);
    expect(toolOutputs()[1]).toMatch(/não tem fotos cadastradas/);
    expect(report.sent).toBe(1);
    expect(sentToCustomer.map((m) => m.kind)).toEqual(["text"]);
  });

  it("produto indisponível não aparece na busca nem recebe foto", async () => {
    const { report } = await turn("Vocês vendem roupas? Tem o vestido azul longo? Manda foto", [
      call("search_products", { query: "vestido azul longo" }),
      call("send_product_photos", { product_id: ids.pOff }, "c2"),
      "Esse modelo não está disponível agora. Posso chamar alguém da equipe?",
    ]);
    const outputs = toolOutputs();
    expect(outputs[0]).toMatch(/Nenhum produto parecido/);
    expect(outputs[0]).not.toContain("Vestido Azul");
    expect(outputs[1]).toMatch(/Produto não encontrado/);
    expect(report.sent).toBe(1);
    expect(sentToCustomer.map((m) => m.kind)).toEqual(["text"]);
  });

  it("isolamento: produto de outra empresa não aparece, não recebe foto e nunca é lido pelas portas", async () => {
    const { report } = await turn("tem camiseta secreta roxa? manda foto", [
      call("search_products", { query: "camiseta secreta roxa" }),
      call("send_product_photos", { product_id: ids.pB }, "c2"),
      "Não encontrei esse modelo. Quer que eu chame alguém da equipe?",
    ]);
    expect(toolOutputs().join("\n")).not.toContain("Secreta");
    expect(toolOutputs()[1]).toMatch(/Produto não encontrado/);
    expect(report.sent).toBe(1);
    expect(sentToCustomer.map((m) => m.kind)).toEqual(["text"]);

    await withOrg(db, A, async (tx) => {
      const port = createCatalogPort({ tx, organizationId: A });
      const scope = { organizationId: A, conversationId: "c", contactId: "x", agentId: "a" };
      expect((await port.listAvailable(scope)).map((p) => p.name).sort()).toEqual(["Camiseta Preta G", "Camiseta Preta M"]);
      expect(await port.getProduct(scope, ids.pB)).toBeNull();
      expect(await port.getProduct(scope, ids.pOff)).toBeNull();
      expect(await port.getProduct(scope, "nao-e-uuid")).toBeNull();
      // a porta recusa um escopo de outra empresa
      await expect(port.listAvailable({ ...scope, organizationId: B })).rejects.toThrow(/Escopo inválido/);
      // nem a escolha de fotos enxerga produto de outra empresa
      expect(await pickProductPhotos(tx, A, [ids.pB])).toEqual([]);
      expect(await pickProductPhotos(tx, A, [ids.pOff])).toEqual([]);
    });
  });

  it("interesse de compra: nota interna do agente + equipe chamada + aviso ao cliente", async () => {
    llmState.intent = "buy";
    const { conv, report } = await turn("Fechado! Quero 2 camisetas pretas G, pago no Pix e retiro na loja", [
      call("search_products", { query: "camiseta preta g" }),
      {
        text: "Perfeito! Anotei tudo e uma pessoa da equipe vai continuar com você.",
        ...(call("register_interest", { summary: "2 unidades, pagamento no Pix, retirada na loja", product_ids: [ids.pG] }, "c2") as object),
      },
    ]);
    expect(report.result?.handoff).toMatchObject({ kind: "model_request" });
    expect(sentToCustomer.map((m) => m.text)).toEqual([expect.stringMatching(/equipe vai continuar/)]);

    const [after] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
    expect(after?.status).toBe("handoff_requested");

    const all = await messagesOf(conv.id);
    const note = all.find((m) => m.kind === "note");
    expect(note).toMatchObject({ direction: "internal", senderKind: "agent", senderName: "Agente Duck" });
    expect(note!.body).toContain("Interesse de compra");
    expect(note!.body).toContain("- Camiseta Preta G — R$ 59,90");
    expect(note!.body).toContain("2 unidades, pagamento no Pix, retirada na loja");
    // o cliente nunca recebe a nota
    expect(sentToCustomer.some((m) => (m.text ?? "").includes("Interesse de compra"))).toBe(false);
    expect(all.some((m) => m.kind === "event" && /chamou a equipe: Interesse de compra/.test(m.body))).toBe(true);
  });

  it("valor inventado pelo modelo é barrado (o catálogo é a única fonte de preço)", async () => {
    const { report } = await turn("quanto custa a camiseta preta g?", [call("search_products", { query: "camiseta preta g" }), "Ela sai por R$ 39,90 hoje!"]);
    expect(report.result?.blocked).toEqual(["invented_price"]);
    expect(report.result?.handoff?.kind).toBe("guardrail");
    expect(sentToCustomer.map((m) => m.kind)).toEqual(["text"]);
    expect(sentToCustomer[0]!.text).not.toContain("39,90");
  });

  it("armazenamento fora do ar: o texto vai, a foto é pulada e o turno não cai", async () => {
    useMedia({ storage: null });
    const { report } = await turn("manda a foto da camiseta preta g", [call("send_product_photos", { product_id: ids.pG }), "Claro, já te mando a foto."]);
    expect(report.result?.handoff).toBeNull();
    expect(report.sent).toBe(1);
    expect(sentToCustomer.map((m) => m.kind)).toEqual(["text"]);
    expect(logs.some((l) => l.message === "conversations.ai.photos_skipped")).toBe(true);
  });

  it("falha ao copiar o objeto: foto pulada, nada sobra no banco nem no armazenamento", async () => {
    const before = mem.objects.size;
    const orig = mem.getObject.bind(mem);
    mem.getObject = async () => null; // o objeto do catálogo sumiu
    try {
      const { report } = await turn("foto da camiseta preta g por favor", [call("send_product_photos", { product_id: ids.pG }), "Claro! Já mando."]);
      expect(report.result?.handoff).toBeNull();
      expect(sentToCustomer.map((m) => m.kind)).toEqual(["text"]);
      expect(logs.some((l) => l.message === "conversations.ai.photo_failed")).toBe(true);
    } finally {
      mem.getObject = orig;
    }
    expect(mem.objects.size).toBe(before);
  });

  it("sem produto disponível a empresa não recebe as ferramentas de catálogo (nem as regras)", async () => {
    await withOrg(db, A, (tx) => tx.update(schema.products).set({ available: false }).where(inArray(schema.products.id, [ids.pG, ids.pM])));
    try {
      await turn("oi, tudo bem?", ["Oi! Como posso ajudar?"]);
      const req = smartRequests()[0]!;
      expect(req.tools!.map((t) => t.name)).not.toContain("search_products");
      expect(req.system).not.toMatch(/CATÁLOGO/);
    } finally {
      await withOrg(db, A, (tx) => tx.update(schema.products).set({ available: true }).where(inArray(schema.products.id, [ids.pG, ids.pM])));
    }
  });

  it("entrega de fotos é idempotente: repetir o mesmo gatilho não duplica mensagem nem cópia", async () => {
    const from = phone();
    await inbound(from, "oi");
    const conv = await convOf(from);
    const send = () =>
      withOrg(db, A, (tx) =>
        sendProductPhotos(tx, {
          conv,
          channelName: "Canal",
          to: from,
          agent: { id: ids.agent, name: "Agente Duck" },
          productIds: [ids.pG],
          triggerId: "gatilho-1",
          now: now(),
          log: { warn: () => {} },
        }),
      );
    // as duas fotos do produto vão (3 no máximo por turno); a repetição entrega o que já existe, sem copiar de novo
    expect(await send()).toBe(2);
    expect(await send()).toBe(2);
    const images = (await messagesOf(conv.id)).filter((m) => m.kind === "image");
    expect(images).toHaveLength(2);
    expect(images.map((m) => m.externalId).sort()).toEqual([`ai:${conv.id}:gatilho-1:photo:0`, `ai:${conv.id}:gatilho-1:photo:1`]);
    const copies = await withOrg(db, A, (tx) => tx.select().from(schema.mediaFiles).where(inArray(schema.mediaFiles.messageId, images.map((m) => m.id))));
    expect(copies).toHaveLength(2);
    // só a primeira foto leva legenda
    expect(images.map((m) => m.body).sort()).toEqual(["", "Camiseta Preta G — R$ 59,90"]);
  });
});
