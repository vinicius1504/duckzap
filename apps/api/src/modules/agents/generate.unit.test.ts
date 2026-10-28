import { buildSystemPrompt, generatedAgentSchema, type AgentRuntimeConfig } from "@duckzap/ai";
import {
  AGENT_OBJECTIVE_SUGGESTIONS,
  AGENT_RESTRICTION_SUGGESTIONS,
  agentConfigSchema,
  agentGeneratorInputSchema,
  agentGeneratorOutputSchema,
  agentGeneratorStoredSchema,
  GENERATOR_MISSING_FIELD_KEYS,
  type AgentConfig,
} from "@duckzap/contracts/agents";
import { describe, expect, it } from "vitest";
import { formatGeneratorIssues } from "./generate";

const oldConfig = {
  name: "Duck",
  profile: { description: "Atende clientes", tone: "friendly", companySummary: "Clínica." },
  knowledge: { productsAndServices: "Limpeza", faq: "Atendemos Unimed." },
  behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 6 },
  followUp: { enabled: false, steps: [], respectBusinessHours: true, stopOnReply: true },
  scheduling: { canBook: false, appointmentTypeIds: [] },
  advanced: { prompt: "Nunca invente preços.", tools: ["request_human"] },
};
const ex = (n: number) => Array.from({ length: n }, (_, i) => ({ customer: `c${i}`, agent: `a${i}` }));

describe("config do agente com knowledge.examples", () => {
  it("config salva antes do campo continua válida (sem examples)", () => {
    const parsed = agentConfigSchema.parse(oldConfig);
    expect(parsed.knowledge.examples ?? []).toEqual([]);
  });

  it("aceita até 12 exemplos de até 400 caracteres por lado; recusa além disso", () => {
    const withEx = (examples: unknown) => agentConfigSchema.safeParse({ ...oldConfig, knowledge: { ...oldConfig.knowledge, examples } });
    expect(withEx(ex(12)).success).toBe(true);
    expect(withEx(ex(13)).success).toBe(false);
    expect(withEx([{ customer: "x".repeat(401), agent: "ok" }]).success).toBe(false);
    expect(withEx([{ customer: "x".repeat(400), agent: "y".repeat(400) }]).success).toBe(true);
    expect(withEx([{ customer: "", agent: "ok" }]).success).toBe(false);
  });

  it("o tipo do contrato é atribuível ao tipo de runtime e os exemplos chegam ao prompt (sem mexer nas regras internas)", () => {
    const config: AgentConfig = agentConfigSchema.parse({ ...oldConfig, knowledge: { ...oldConfig.knowledge, examples: ex(2) } });
    const runtime: AgentRuntimeConfig = config;
    expect(buildSystemPrompt(runtime)).toContain("Cliente: c0");
    expect(buildSystemPrompt(agentConfigSchema.parse(oldConfig))).not.toContain("Exemplos de como responder");
  });
});

describe("contrato do gerador", () => {
  const base = { purpose: "sales", agentName: "Duda", tone: "friendly", companyText: "A Nexora faz sites e sistemas para empresas." };

  it("aceita o mínimo e preenche companyText vazio quando 'sells' basta", () => {
    expect(agentGeneratorInputSchema.safeParse(base).success).toBe(true);
    const bySells = agentGeneratorInputSchema.safeParse({ purpose: "support", agentName: "Duda", tone: "formal", sells: "Sites e sistemas" });
    expect(bySells.success).toBe(true);
    if (bySells.success) expect(bySells.data.companyText).toBe("");
  });

  it("recusa finalidade/tom fora da lista, nome vazio, texto vazio e acima do limite", () => {
    expect(agentGeneratorInputSchema.safeParse({ ...base, purpose: "x" }).success).toBe(false);
    expect(agentGeneratorInputSchema.safeParse({ ...base, tone: "x" }).success).toBe(false);
    expect(agentGeneratorInputSchema.safeParse({ ...base, agentName: " " }).success).toBe(false);
    expect(agentGeneratorInputSchema.safeParse({ ...base, companyText: "" }).success).toBe(false);
    expect(agentGeneratorInputSchema.safeParse({ ...base, companyText: "a".repeat(20_001) }).success).toBe(false);
    expect(agentGeneratorInputSchema.safeParse({ ...base, hours: "a".repeat(401) }).success).toBe(false);
    for (const purpose of ["reception", "sales", "support", "scheduling"]) expect(agentGeneratorInputSchema.safeParse({ ...base, purpose }).success).toBe(true);
  });

  it("mensagem de validação em pt-BR com o nome do campo como a pessoa vê", () => {
    const r = agentGeneratorInputSchema.safeParse({ ...base, companyText: "a".repeat(20_001) });
    if (r.success) throw new Error("deveria falhar");
    const f = formatGeneratorIssues(r.error);
    expect(f.message).toContain('Campo "texto da empresa"');
    expect(f.message).toContain("20 mil");
    expect(f.fields.companyText).toBeDefined();
  });

  it("o schema do gerador no pacote de IA e o do contrato aceitam/recusam o mesmo conteúdo (limites em sincronia)", () => {
    const profile = {
      description: "d".repeat(200),
      instructions: "i".repeat(8000),
      companySummary: "c".repeat(2000),
      productsAndServices: "p".repeat(5000),
      faq: "f".repeat(5000),
      companyInfo: "c".repeat(12000),
      restrictions: "r".repeat(3000),
      examples: ex(10).map((e) => ({ customer: e.customer.padEnd(400, "x"), agent: e.agent.padEnd(400, "y") })),
      warnings: ["w"],
    };
    expect(generatedAgentSchema.safeParse(profile).success).toBe(true);
    expect(agentGeneratorOutputSchema.safeParse(profile).success).toBe(true);
    for (const bad of [{ ...profile, description: "d".repeat(201) }, { ...profile, examples: ex(7) }, { ...profile, examples: ex(11) }, { ...profile, faq: "f".repeat(5001) }, { ...profile, instructions: "" }]) {
      expect(generatedAgentSchema.safeParse(bad).success).toBe(false);
      expect(agentGeneratorOutputSchema.safeParse(bad).success).toBe(false);
    }
    // o que foi gerado cabe no agente: pode ser salvo pelas rotas de agentes
    const saved = agentConfigSchema.safeParse({
      ...oldConfig,
      profile: { ...oldConfig.profile, description: profile.description, companySummary: profile.companySummary },
      knowledge: { productsAndServices: profile.productsAndServices, faq: profile.faq, examples: profile.examples.slice(0, 10) },
      advanced: { prompt: profile.instructions, tools: ["request_human"] },
    });
    expect(saved.success).toBe(true);
  });

  it("missingFields é opcional e só aceita as 7 chaves do contrato; o schema do pacote de IA usa as mesmas", () => {
    const profile = {
      description: "d",
      instructions: "i",
      companySummary: "c",
      productsAndServices: "",
      faq: "",
      companyInfo: "Sobre a empresa.",
      examples: ex(8),
      warnings: [],
    };
    expect(agentGeneratorOutputSchema.safeParse(profile).success).toBe(true);
    expect(GENERATOR_MISSING_FIELD_KEYS).toEqual(["sells", "doesNotSell", "paymentMethods", "hours", "location", "budgetProcess", "handoffRules"]);
    for (const key of GENERATOR_MISSING_FIELD_KEYS) {
      expect(agentGeneratorOutputSchema.safeParse({ ...profile, missingFields: [key] }).success).toBe(true);
      expect(generatedAgentSchema.safeParse({ ...profile, missingFields: [key] }).success).toBe(true);
    }
    for (const bad of [["cpf"], ["restrictions"], "hours"]) {
      expect(agentGeneratorOutputSchema.safeParse({ ...profile, missingFields: bad }).success).toBe(false);
      expect(generatedAgentSchema.safeParse({ ...profile, missingFields: bad }).success).toBe(false);
    }
  });

  it("config.generator: opcional, limites iguais aos da entrada do gerador, e atribuível ao tipo de runtime", () => {
    const generator = { purpose: "support", companyText: "Texto da empresa.", sells: "Sites", restrictions: "Nunca mencionar preços" };
    const parsed = agentConfigSchema.parse({ ...oldConfig, generator });
    expect(parsed.generator).toEqual(generator);
    const runtime: AgentRuntimeConfig = parsed;
    expect(runtime.generator?.purpose).toBe("support");
    // limites
    const stored = (over: object) => agentGeneratorStoredSchema.safeParse({ ...generator, ...over }).success;
    const input = (over: object) => agentGeneratorInputSchema.safeParse({ ...generator, agentName: "Duda", tone: "friendly", companyText: "Texto da empresa que passa de vinte.", ...over }).success;
    expect(stored({ companyText: "x".repeat(20_000) })).toBe(true);
    expect(stored({ companyText: "x".repeat(20_001) })).toBe(false);
    expect(stored({ purpose: "x" })).toBe(false);
    for (const [field, max] of [["sells", 1500], ["doesNotSell", 800], ["paymentMethods", 500], ["hours", 400], ["location", 400], ["budgetProcess", 1000], ["askBeforeHandoff", 600], ["handoffRules", 1000], ["restrictions", 1000], ["customInstructions", 2000]] as const) {
      expect([stored({ [field]: "a".repeat(max) }), input({ [field]: "a".repeat(max) })]).toEqual([true, true]);
      expect([stored({ [field]: "a".repeat(max + 1) }), input({ [field]: "a".repeat(max + 1) })]).toEqual([false, false]);
    }
    // nome e tom não são guardados aqui (ficam em name e profile.tone)
    expect(Object.keys(agentGeneratorStoredSchema.parse({ ...generator, agentName: "Duda", tone: "formal" }))).not.toContain("tone");
  });

  it("config com companyInfo e restrictions: opcionais, com limites 12000 e 3000; o prompt do runtime os recebe", () => {
    const withNew = (knowledge: object, advanced: object) =>
      agentConfigSchema.safeParse({ ...oldConfig, knowledge: { ...oldConfig.knowledge, ...knowledge }, advanced: { ...oldConfig.advanced, ...advanced } });
    expect(agentConfigSchema.safeParse(oldConfig).success).toBe(true); // config antiga, sem os campos
    expect(withNew({ companyInfo: "c".repeat(12_000) }, { restrictions: "r".repeat(3_000) }).success).toBe(true);
    expect(withNew({ companyInfo: "c".repeat(12_001) }, {}).success).toBe(false);
    expect(withNew({}, { restrictions: "r".repeat(3_001) }).success).toBe(false);
    const parsed = withNew({ companyInfo: "Atendemos Unimed." }, { restrictions: "- Não usar gírias." });
    if (!parsed.success) throw new Error("deveria passar");
    const runtime: AgentRuntimeConfig = parsed.data;
    const prompt = buildSystemPrompt(runtime);
    expect(prompt).toContain("Informações da empresa:\nAtendemos Unimed.");
    expect(prompt).toContain("Restrições da empresa (o que NUNCA fazer):\n- Não usar gírias.");
    expect(buildSystemPrompt(agentConfigSchema.parse(oldConfig))).not.toContain("Informações da empresa:");
  });

  it("saída do gerador no formato novo: companyInfo obrigatório, restrictions/productsAndServices/faq com padrão vazio", () => {
    const profile = { description: "d", instructions: "i", companySummary: "c", companyInfo: "## Sobre a empresa\nX", examples: ex(8), warnings: [] };
    const parsed = agentGeneratorOutputSchema.parse(profile);
    expect(parsed).toMatchObject({ restrictions: "", productsAndServices: "", faq: "" });
    expect(generatedAgentSchema.parse(profile)).toMatchObject({ restrictions: "", productsAndServices: "", faq: "" });
    for (const schema of [agentGeneratorOutputSchema, generatedAgentSchema]) {
      const { companyInfo: _c, ...withoutInfo } = profile;
      void _c;
      expect(schema.safeParse(withoutInfo).success).toBe(false);
      expect(schema.safeParse({ ...profile, companyInfo: "c".repeat(12_001) }).success).toBe(false);
      expect(schema.safeParse({ ...profile, restrictions: "r".repeat(3_001) }).success).toBe(false);
    }
    // o gerado cabe no agente: pode ser salvo
    const saved = agentConfigSchema.safeParse({
      ...oldConfig,
      knowledge: { productsAndServices: "", faq: "", companyInfo: "c".repeat(12_000) },
      advanced: { prompt: "i", tools: ["request_human"], restrictions: "r".repeat(3_000) },
    });
    expect(saved.success).toBe(true);
  });

  it("sugestões para a tela são listas fixas em pt-BR", () => {
    expect(AGENT_RESTRICTION_SUGGESTIONS).toHaveLength(9);
    expect(AGENT_OBJECTIVE_SUGGESTIONS).toHaveLength(4);
    expect(AGENT_RESTRICTION_SUGGESTIONS).toContain("Nunca mencionar preços");
    expect(AGENT_OBJECTIVE_SUGGESTIONS).toContain("Usar linguagem formal");
  });
});
