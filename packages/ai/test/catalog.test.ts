import { describe, expect, it } from "vitest";
import {
  buildRulesBlock,
  buildToolDefs,
  createInMemoryPorts,
  editDistance,
  effectiveCatalogConfig,
  enabledToolNames,
  executeTool,
  formatPrice,
  rankProducts,
  tokenize,
  type KnowledgeHit,
  type ProductInfo,
  type ToolContext,
} from "../src";
import { runScenario, sampleConfig, type Scenario } from "../evals/harness";

const P = (id: string, name: string, priceCents: number | null, description = "", photoCount = 0): ProductInfo => ({ id, name, description, priceCents, photoCount });

const CAMISETA_M = P("p1", "Camiseta Preta M", 5990, "Algodão, malha 30.1, tamanho M.", 2);
const CAMISETA_G = P("p2", "Camiseta Preta G", 5990, "Algodão, malha 30.1, tamanho G.", 1);
const CAMISETA_BRANCA = P("p3", "Camiseta Branca M", 5990, "Algodão, tamanho M.", 0);
const VESTIDO = P("p4", "Vestido Azul Longo", 12990, "Vestido longo azul royal para festa.", 3);
const TENIS = P("p5", "Tênis Corrida 38", 29990, "Tênis de corrida leve, numeração 38.", 1);
const MOCHILA = P("p6", "Mochila Executiva", null, "Mochila para notebook até 15 polegadas.", 0);
const CATALOG = [CAMISETA_M, CAMISETA_G, CAMISETA_BRANCA, VESTIDO, TENIS, MOCHILA];

describe("ranking: peças básicas", () => {
  it("tokeniza sem acento, pontuação, stopwords e plural", () => {
    expect(tokenize("Quero uma Camisêta, pretas!")).toEqual(["camiseta", "preta"]);
    expect(tokenize("tem?")).toEqual([]);
    // o plural simples vale dos dois lados (consulta e produto), então "tênis" casa com "tenis" mesmo sem virar palavra de dicionário
    expect(tokenize("Tênis 38")).toEqual(tokenize("TENIS 38"));
    expect(tokenize("Tênis 38")).toHaveLength(2);
  });

  it("distância de edição conta troca de letras vizinhas como 1", () => {
    expect(editDistance("camiseta", "camiseta")).toBe(0);
    expect(editDistance("camiseat", "camiseta")).toBe(1);
    expect(editDistance("camizeta", "camiseta")).toBe(1);
    expect(editDistance("camisa", "camiseta")).toBe(2);
  });

  it("formata o preço como o contrato", () => {
    expect(formatPrice(5990)).toBe("R$ 59,90");
    expect(formatPrice(129990)).toBe("R$ 1.299,90");
    expect(formatPrice(5)).toBe("R$ 0,05");
    expect(formatPrice(100)).toBe("R$ 1,00");
  });
});

describe("ranking: achar o produto mais próximo", () => {
  it("nome completo e variante certa: confiança alta e sem ambiguidade", () => {
    const [top] = rankProducts("camiseta preta g", CATALOG);
    expect(top?.product.id).toBe("p2");
    expect(top).toMatchObject({ confidence: "high", ambiguous: false });
  });

  it("variantes (M e G) ficam parecidas: a IA deve perguntar qual", () => {
    const ranked = rankProducts("camiseta preta", CATALOG);
    expect(ranked.slice(0, 2).map((r) => r.product.id).sort()).toEqual(["p1", "p2"]);
    expect(ranked[0]!.ambiguous).toBe(true);
    expect(ranked[1]!.ambiguous).toBe(true);
    expect(ranked.every((r) => r.confidence !== "high")).toBe(true);
    expect(Math.abs(ranked[0]!.score - ranked[1]!.score)).toBeLessThan(0.08);
  });

  it("erro de digitação acha o produto, mas só com confiança média (confirmar)", () => {
    const [top] = rankProducts("camizeta preta g", CATALOG);
    expect(top?.product.id).toBe("p2");
    expect(top?.confidence).toBe("medium");
  });

  it("'camisa' (outra palavra, parecida) ainda traz as camisetas, sem confiança alta", () => {
    const ranked = rankProducts("camisa preta g", CATALOG);
    expect(ranked[0]?.product.id).toBe("p2");
    expect(ranked[0]?.confidence).not.toBe("high");
  });

  it("'prata' não vira 'preta' com confiança alta", () => {
    const ranked = rankProducts("camiseta prata g", CATALOG);
    expect(ranked.every((r) => r.confidence !== "high")).toBe(true);
  });

  it("sem acento, maiúsculas e ordem trocada", () => {
    expect(rankProducts("TENIS corrida 38", CATALOG)[0]).toMatchObject({ product: { id: "p5" }, confidence: "high" });
    expect(rankProducts("tênis de corrida 38", CATALOG)[0]?.product.id).toBe("p5");
    expect(rankProducts("preta camiseta m", CATALOG)[0]).toMatchObject({ product: { id: "p1" }, confidence: "high" });
  });

  it("plural e frase solta: 'quero as camisetas pretas'", () => {
    const top2 = rankProducts("quero as camisetas pretas", CATALOG).slice(0, 2);
    expect(top2.map((r) => r.product.id).sort()).toEqual(["p1", "p2"]);
  });

  it("nome parcial (começo da palavra)", () => {
    expect(rankProducts("vest azul", CATALOG)[0]?.product.id).toBe("p4");
    expect(rankProducts("mochila", CATALOG)[0]).toMatchObject({ product: { id: "p6" }, confidence: "high" });
  });

  it("descrição vaga: 'aquela do vestido azul'", () => {
    const [top] = rankProducts("aquela do vestido azul", CATALOG);
    expect(top?.product.id).toBe("p4");
    expect(top?.confidence).not.toBe("low");
  });

  it("acha pela descrição quando o nome não ajuda", () => {
    expect(rankProducts("notebook", CATALOG)[0]?.product.id).toBe("p6");
    expect(rankProducts("royal", CATALOG)[0]?.product.id).toBe("p4");
  });

  it("consulta genérica traz vários candidatos, todos ambíguos", () => {
    const ranked = rankProducts("camiseta", CATALOG);
    expect(ranked.map((r) => r.product.id).sort()).toEqual(["p1", "p2", "p3"]);
    expect(ranked.every((r) => r.ambiguous && r.confidence !== "high")).toBe(true);
  });

  it("nome exato vence mesmo havendo nome maior que o contém", () => {
    const products = [P("a", "Camiseta Preta", 4000), P("b", "Camiseta Preta Manga Longa", 6000)];
    const [top] = rankProducts("camiseta preta", products);
    expect(top).toMatchObject({ product: { id: "a" } });
  });

  it("consulta sem relação: nada (nunca chuta)", () => {
    expect(rankProducts("geladeira inox duplex", CATALOG)).toEqual([]);
    expect(rankProducts("qual o horário de vocês", CATALOG)).toEqual([]);
  });

  it("lista vazia e consulta só de palavras vazias não quebram", () => {
    expect(rankProducts("camiseta", [])).toEqual([]);
    expect(rankProducts("tem?", CATALOG)).toEqual([]);
    expect(rankProducts("   ", CATALOG)).toEqual([]);
  });

  it("respeita o limite e ordena do mais para o menos parecido", () => {
    const ranked = rankProducts("camiseta", CATALOG, { limit: 2 });
    expect(ranked).toHaveLength(2);
    const scores = rankProducts("camiseta preta m", CATALOG).map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("número e letra de tamanho só casam exatos: 'tênis 39' sugere o 38, sem confiança alta", () => {
    const [top] = rankProducts("tenis 39", CATALOG);
    expect(top?.product.id).toBe("p5");
    expect(top?.confidence).not.toBe("high");
    expect(rankProducts("tenis 38", CATALOG)[0]?.confidence).toBe("high");
  });
});

// ---------- ferramentas ----------

const NOW = new Date("2026-10-26T12:00:00Z");
const SCOPE = { organizationId: "org_test", conversationId: "conv_test", contactId: "contact_test", agentId: "agt_test" };

function setup(options: { catalog?: boolean; dryRun?: boolean; products?: ProductInfo[] } = {}) {
  const { ports, state } = createInMemoryPorts({ products: options.products ?? CATALOG, now: () => NOW });
  const config = effectiveCatalogConfig(sampleConfig(), options.catalog ?? true);
  const photos: string[] = [];
  const knowledge: KnowledgeHit[] = [];
  const ctx: ToolContext = {
    scope: SCOPE,
    config,
    ports,
    dryRun: options.dryRun ?? false,
    now: NOW,
    allowedTags: [],
    onKnowledge: (hits) => knowledge.push(...hits),
    requestPhotos: (productId) => {
      if (photos.includes(productId)) return "duplicate";
      if (photos.length >= 2) return "limit";
      photos.push(productId);
      return "added";
    },
  };
  const defs = buildToolDefs(ctx);
  return { ctx, defs, state, photos, knowledge, run: (name: string, input: Record<string, unknown>) => executeTool(defs, ctx, name, input) };
}

describe("ferramentas de catálogo: ligadas pelo sistema", () => {
  it("só existem quando a empresa tem produto disponível", () => {
    const on = enabledToolNames(effectiveCatalogConfig(sampleConfig(), true));
    expect([...on]).toEqual(expect.arrayContaining(["search_products", "send_product_photos", "register_interest"]));
    const off = enabledToolNames(effectiveCatalogConfig(sampleConfig(), false));
    for (const tool of ["search_products", "send_product_photos", "register_interest"] as const) expect(off.has(tool)).toBe(false);
    // listar nelas em advanced.tools não liga nada
    const forced = enabledToolNames({ ...sampleConfig(), advanced: { ...sampleConfig().advanced, tools: ["search_products"] } });
    expect(forced.has("search_products")).toBe(false);
  });

  it("as regras do catálogo só entram no prompt quando ligado", () => {
    expect(buildRulesBlock(effectiveCatalogConfig(sampleConfig(), false))).not.toMatch(/CATÁLOGO/);
    const rules = buildRulesBlock(effectiveCatalogConfig(sampleConfig(), true));
    expect(rules).toMatch(/13\. CATÁLOGO/);
    expect(rules).toMatch(/register_interest/);
  });

  it("effectiveCatalogConfig não muda o objeto original", () => {
    const original = sampleConfig();
    const next = effectiveCatalogConfig(original, true);
    expect(original.catalog).toBeUndefined();
    expect(next.catalog).toEqual({ enabled: true });
  });
});

describe("search_products", () => {
  it("devolve candidatos com id, valor, fotos e confiança", async () => {
    const t = setup();
    const out = await t.run("search_products", { query: "camiseta preta g" });
    expect(out.ok).toBe(true);
    expect(out.output).toMatch(/product_id=p2 \| Camiseta Preta G \| R\$ 59,90 \| 1 foto \| confiança ALTA/);
    expect(out.output).toMatch(/Correspondência de confiança ALTA/);
  });

  it("variantes parecidas: manda perguntar qual", async () => {
    const out = await setup().run("search_products", { query: "camiseta preta" });
    expect(out.output).toMatch(/QUAL deles/);
    expect(out.output).toMatch(/Camiseta Preta M/);
    expect(out.output).toMatch(/Camiseta Preta G/);
  });

  it("erro de digitação: manda CONFIRMAR com o cliente", async () => {
    const out = await setup().run("search_products", { query: "camizeta branca" });
    expect(out.output).toMatch(/CONFIRME com o cliente \("Você quis dizer Camiseta Branca M\?"\)/);
  });

  it("sem resultado: não inventa e oferece a equipe", async () => {
    const out = await setup().run("search_products", { query: "geladeira" });
    expect(out.ok).toBe(true);
    expect(out.output).toMatch(/Nenhum produto parecido/);
    expect(out.output).toMatch(/chamar a equipe/);
  });

  it("produto sem preço aparece como 'valor sob consulta'", async () => {
    const out = await setup().run("search_products", { query: "mochila executiva" });
    expect(out.output).toMatch(/Mochila Executiva \| valor sob consulta/);
  });

  it("alimenta o corpus do guardrail com os valores do catálogo", async () => {
    const t = setup();
    await t.run("search_products", { query: "vestido azul" });
    expect(t.knowledge.map((k) => k.text).join("\n")).toContain("R$ 129,90");
  });

  it("campos extras do modelo (organization_id) são descartados e não vazam para a porta", async () => {
    const t = setup();
    const out = await t.run("search_products", { query: "tenis", organization_id: "outra_empresa" });
    expect(out.ok).toBe(true);
    expect(out.trace?.args).toEqual({ query: "tenis" });
  });

  it("empresa sem produtos: resposta limpa, sem erro", async () => {
    const out = await setup({ products: [] }).run("search_products", { query: "camiseta" });
    expect(out.ok).toBe(true);
    expect(out.output).toMatch(/Nenhum produto parecido/);
  });

  it("sem o catálogo ligado a ferramenta nem existe", async () => {
    const out = await setup({ catalog: false }).run("search_products", { query: "camiseta" });
    expect(out.ok).toBe(false);
    expect(out.output).toMatch(/não existe ou não está liberada/);
  });
});

describe("send_product_photos", () => {
  it("registra o pedido (não envia) e é idempotente", async () => {
    const t = setup();
    const first = await t.run("send_product_photos", { product_id: "p1" });
    expect(first.ok).toBe(true);
    expect(first.output).toMatch(/vão ser enviadas/);
    const again = await t.run("send_product_photos", { product_id: "p1" });
    expect(again.output).toMatch(/já vão ser enviadas/);
    expect(t.photos).toEqual(["p1"]);
  });

  it("produto sem fotos: avisa e não registra", async () => {
    const t = setup();
    const out = await t.run("send_product_photos", { product_id: "p3" });
    expect(out.ok).toBe(true);
    expect(out.output).toMatch(/não tem fotos cadastradas/);
    expect(t.photos).toEqual([]);
  });

  it("produto que não existe (ou de outra empresa): erro, nada registrado", async () => {
    const t = setup();
    const out = await t.run("send_product_photos", { product_id: "inventado" });
    expect(out.ok).toBe(false);
    expect(t.photos).toEqual([]);
  });

  it("no máximo 2 produtos por turno", async () => {
    const t = setup();
    expect((await t.run("send_product_photos", { product_id: "p1" })).ok).toBe(true);
    expect((await t.run("send_product_photos", { product_id: "p2" })).ok).toBe(true);
    const third = await t.run("send_product_photos", { product_id: "p4" });
    expect(third.ok).toBe(false);
    expect(third.output).toMatch(/2 produtos por vez/);
    expect(t.photos).toEqual(["p1", "p2"]);
  });

  it("simulador/copiloto (dry-run): não registra nada", async () => {
    const t = setup({ dryRun: true });
    const out = await t.run("send_product_photos", { product_id: "p1" });
    expect(out.output).toMatch(/\(teste\)/);
    expect(t.photos).toEqual([]);
  });
});

describe("register_interest", () => {
  it("grava nota interna com produtos e preço do CATÁLOGO e chama a equipe", async () => {
    const t = setup();
    const out = await t.run("register_interest", { summary: "2 unidades, paga no Pix, entrega em Campo Grande, preço R$ 10,00 cada", product_ids: ["p2", "inventado"] });
    expect(out.ok).toBe(true);
    expect(t.state.notes).toHaveLength(1);
    const note = t.state.notes[0]!;
    expect(note).toMatch(/Interesse de compra/);
    expect(note).toContain("- Camiseta Preta G — R$ 59,90");
    expect(note).not.toContain("inventado");
    expect(note).toMatch(/2 unidades, paga no Pix/);
    expect(t.state.humanRequests).toEqual([expect.stringMatching(/^Interesse de compra: 2 unidades/)]);
    expect(out.handoffReason).toMatch(/^Interesse de compra:/);
  });

  it("sem produto identificado ainda registra o resumo", async () => {
    const t = setup();
    const out = await t.run("register_interest", { summary: "Quer um presente para o dia das mães" });
    expect(out.ok).toBe(true);
    expect(t.state.notes[0]).not.toMatch(/Produtos:/);
    expect(t.state.notes[0]).toMatch(/presente/);
  });

  it("dry-run: nada gravado, mas o handoff aparece no simulador", async () => {
    const t = setup({ dryRun: true });
    const out = await t.run("register_interest", { summary: "Quer comprar 1 camiseta preta G", product_ids: ["p2"] });
    expect(out.output).toMatch(/\(teste\)/);
    expect(t.state.notes).toEqual([]);
    expect(t.state.humanRequests).toEqual([]);
    expect(out.handoffReason).toMatch(/^Interesse de compra:/);
  });

  it("exige resumo", async () => {
    const out = await setup().run("register_interest", { summary: "" });
    expect(out.ok).toBe(false);
  });
});

// ---------- turno completo (LLM roteirizado) ----------

const config = effectiveCatalogConfig(sampleConfig(), true);
const call = (name: string, input: Record<string, unknown>, id = `t_${name}`) => ({ toolCalls: [{ id, name, input }], stopReason: "tool_use" as const });

const base = (over: Partial<Scenario>): Scenario => ({
  id: "catalogo",
  description: "catálogo",
  config,
  products: CATALOG,
  history: [{ role: "customer", text: "Vocês têm a camiseta preta G?" }],
  router: { intent: "question", confidence: 0.9 },
  expect: {},
  ...over,
});

describe("turno: catálogo no pipeline", () => {
  it("busca e responde com o valor do catálogo (passa no guardrail de preço)", async () => {
    const { result } = await runScenario(
      base({
        model: [call("search_products", { query: "camiseta preta g" }), "Temos sim! A Camiseta Preta G sai por R$ 59,90. Quer que eu te mande a foto?"],
      }),
    );
    expect(result.handoff).toBeNull();
    expect(result.blocked).toEqual([]);
    expect(result.messages.join(" ")).toContain("R$ 59,90");
    expect(result.toolCalls.map((t) => t.tool)).toEqual(["search_products"]);
  });

  it("valor inventado continua barrado pelo guardrail", async () => {
    const { result } = await runScenario(
      base({
        model: [call("search_products", { query: "camiseta preta g" }), "A Camiseta Preta G sai por R$ 49,90 hoje!"],
      }),
    );
    expect(result.blocked).toEqual(["invented_price"]);
    expect(result.handoff?.kind).toBe("guardrail");
  });

  it("pergunta sobre produto cadastrado não é 'fora do conhecimento' (sem catálogo seria transferida)", async () => {
    const history = [{ role: "customer" as const, text: "Vocês têm tênis de corrida?" }];
    const without = await runScenario(base({ config: sampleConfig(), products: [], history, model: [] }));
    expect(without.result.handoff?.kind).toBe("unknown_knowledge");

    const withCatalog = await runScenario(
      base({ history, model: [call("search_products", { query: "tenis corrida" }), "Temos o Tênis Corrida 38 por R$ 299,90. Qual é o seu número?"] }),
    );
    expect(withCatalog.result.handoff).toBeNull();
    expect(withCatalog.result.messages.join(" ")).toContain("R$ 299,90");
  });

  it("pergunta sem relação com o catálogo continua indo para a equipe", async () => {
    const { result } = await runScenario(base({ history: [{ role: "customer", text: "Qual o CNPJ de vocês no governo federal?" }], model: [] }));
    expect(result.handoff?.kind).toBe("unknown_knowledge");
  });

  it("foto: o pedido sai no resultado, sem duplicar", async () => {
    const { result } = await runScenario(
      base({
        history: [{ role: "customer", text: "Manda a foto da camiseta preta M" }],
        model: [
          call("search_products", { query: "camiseta preta m" }),
          call("send_product_photos", { product_id: "p1" }, "t2"),
          call("send_product_photos", { product_id: "p1" }, "t3"),
          "Claro! Te mando a foto da Camiseta Preta M aqui.",
        ],
      }),
    );
    expect(result.photoRequests).toEqual([{ productId: "p1" }]);
    expect(result.messages.join(" ")).toMatch(/foto/);
  });

  it("foto some quando a resposta é barrada pelo guardrail", async () => {
    const { result } = await runScenario(
      base({
        model: [call("send_product_photos", { product_id: "p1" }), "Leva por R$ 10,00 só hoje!"],
      }),
    );
    expect(result.handoff?.kind).toBe("guardrail");
    expect(result.photoRequests).toEqual([]);
  });

  it("interesse de compra: nota interna + equipe chamada + aviso ao cliente", async () => {
    const { result, fake } = await runScenario(
      base({
        history: [{ role: "customer", text: "Fechado, quero 2 camisetas pretas G, pago no Pix e retiro na loja" }],
        router: { intent: "buy", confidence: 0.95 },
        model: [
          {
            text: "Perfeito! Já deixei tudo anotado e uma pessoa da equipe vai continuar com você.",
            ...call("register_interest", { summary: "2 unidades, pagamento no Pix, retirada na loja", product_ids: ["p2"] }),
          },
        ],
      }),
    );
    expect(result.handoff).toMatchObject({ kind: "model_request" });
    expect(result.handoff?.reason).toMatch(/^Interesse de compra:/);
    expect(result.messages.join(" ")).toMatch(/equipe vai continuar/);
    expect(fake.notes).toHaveLength(1);
    expect(fake.notes[0]).toContain("Camiseta Preta G — R$ 59,90");
    expect(fake.humanRequests).toHaveLength(1);
  });

  it("simulador: register_interest não grava nada", async () => {
    const { result, fake } = await runScenario(
      base({
        mode: "simulator",
        router: { intent: "buy", confidence: 0.95 },
        model: [{ text: "Anotado! A equipe continua com você.", ...call("register_interest", { summary: "1 unidade no Pix", product_ids: ["p2"] }) }],
      }),
    );
    expect(result.handoff?.kind).toBe("model_request");
    expect(fake.notes).toEqual([]);
    expect(fake.humanRequests).toEqual([]);
    expect(result.photoRequests).toEqual([]);
  });

  it("catálogo desligado: o modelo não recebe as ferramentas", async () => {
    const { requests } = await runScenario(base({ config: effectiveCatalogConfig(sampleConfig(), false), model: ["Posso ajudar com outra coisa?"] }));
    const smart = requests.find((r) => r.tier === "smart");
    const names = (smart?.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("search_products");
  });

  it("catálogo ligado: o modelo recebe as três ferramentas e as regras", async () => {
    const { requests } = await runScenario(base({ model: ["Oi! Como posso ajudar?"] }));
    const smart = requests.find((r) => r.tier === "smart");
    expect((smart?.tools ?? []).map((t) => t.name)).toEqual(expect.arrayContaining(["search_products", "send_product_photos", "register_interest"]));
    expect(smart?.system).toMatch(/CATÁLOGO/);
  });
});
