import { GENERATOR_MISSING_FIELD_KEYS, agentConfigSchema, agentGeneratorInputSchema, agentGeneratorOutputSchema, type AgentConfig } from "@duckzap/contracts/agents";
import { describe, expect, it } from "vitest";
import {
  GENERATOR_EXTRA_FIELDS,
  GENERATOR_LIMITS,
  applyExtrasToConfig,
  configFingerprint,
  defaultGeneratorForm,
  filledExtras,
  finalizeConfigForSave,
  formFromConfig,
  formToInput,
  limitErrors,
  mergeExtras,
  noteWarnings,
  normalizeStoredGenerator,
  pendingMissingFields,
  setFormField,
  validateGeneratorForm,
  viewOutcome,
} from "./agent-generator";
import { AFTER_GENERATION_SECTION, EDITOR_SECTIONS, legacyResource, parseEditorSection } from "./agent-tabs";

// Config em edição ↔ formulário ↔ entrada da API, "Complete para melhorar" e abas do editor.

const baseConfig: AgentConfig = {
  name: "Duda",
  profile: { description: "", tone: "formal", companySummary: "" },
  knowledge: { productsAndServices: "", faq: "" },
  behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 6 },
  followUp: { enabled: false, steps: [], respectBusinessHours: true, stopOnReply: true },
  scheduling: { canBook: false, appointmentTypeIds: [] },
  advanced: { prompt: "", tools: ["search_knowledge", "request_human"] },
};
const COMPANY = "A Nexora faz sites e sistemas sob medida para pequenas empresas.";

describe("formulário guardado na config (as 3 perguntas ↔ entrada da API)", () => {
  it("sem `generator`, o formulário nasce vazio com a finalidade do trabalho, o nome e o modo da config", () => {
    const form = formFromConfig(baseConfig, "support");
    expect(form).toMatchObject({ purpose: "support", agentName: "Duda", tone: "formal", companyText: "", customInstructions: "", restrictions: "" });
  });

  it("editar as 3 perguntas grava em `config.generator`; nome e modo vão para os lugares deles", () => {
    let config = baseConfig;
    config = setFormField(config, "support", "companyText", COMPANY);
    config = setFormField(config, "support", "customInstructions", "Ser cordial");
    config = setFormField(config, "support", "restrictions", "Nunca mencionar preços");
    config = setFormField(config, "support", "purpose", "sales");
    config = setFormField(config, "support", "agentName", "Duda 2");
    config = setFormField(config, "support", "tone", "direct");
    expect(config.generator).toEqual({ purpose: "sales", companyText: COMPANY, customInstructions: "Ser cordial", restrictions: "Nunca mencionar preços" });
    expect(config.name).toBe("Duda 2");
    expect(config.profile.tone).toBe("direct");
    expect(agentConfigSchema.safeParse(config).success).toBe(true);
  });

  it("valor inválido de finalidade ou modo é ignorado", () => {
    expect(setFormField(baseConfig, "support", "tone", "bravo").profile.tone).toBe("formal");
    expect(setFormField(baseConfig, "support", "purpose", "x").generator?.purpose).toBe("support");
  });

  it("ida e volta: o que foi guardado reabre igual e gera a mesma entrada", () => {
    const config = setFormField(setFormField(baseConfig, "support", "companyText", COMPANY), "support", "hours", "seg a sex");
    const reopened = formFromConfig(config, "scheduling");
    expect(reopened.purpose).toBe("support");
    expect(reopened.companyText).toBe(COMPANY);
    expect(reopened.hours).toBe("seg a sex");
    expect(formToInput(reopened)).toEqual({ purpose: "support", agentName: "Duda", tone: "formal", companyText: COMPANY, hours: "seg a sex" });
    expect(agentGeneratorInputSchema.safeParse(formToInput(reopened)).success).toBe(true);
  });

  it("ida e volta pela versão salva: salvar e reabrir devolve o mesmo formulário", () => {
    const edited = setFormField(setFormField(baseConfig, "support", "companyText", `  ${COMPANY}  `), "support", "restrictions", " Não usar emojis ");
    const saved = agentConfigSchema.parse(JSON.parse(JSON.stringify(finalizeConfigForSave(edited, "support"))));
    const reopened = formFromConfig(saved, "support");
    expect(reopened.companyText).toBe(COMPANY);
    expect(reopened.restrictions).toBe("Não usar emojis");
    expect(configFingerprint(saved, "support")).toBe(configFingerprint(edited, "support"));
  });

  it("normaliza para salvar: apara, tira vazios e não guarda um formulário sem nada", () => {
    expect(normalizeStoredGenerator(undefined, "support")).toBeUndefined();
    expect(normalizeStoredGenerator({ purpose: "support", companyText: "   ", restrictions: "  " }, "support")).toBeUndefined();
    expect(normalizeStoredGenerator({ purpose: "sales", companyText: "" }, "support")).toEqual({ purpose: "sales", companyText: "" });
    expect(normalizeStoredGenerator({ purpose: "support", companyText: " texto ", sells: " ", hours: " 8h " }, "support")).toEqual({ purpose: "support", companyText: "texto", hours: "8h" });
  });

  it("para salvar, 'Informações da empresa' e 'Restrições' vazias não viram campo; com texto, seguem", () => {
    const withTexts: AgentConfig = { ...baseConfig, knowledge: { ...baseConfig.knowledge, companyInfo: "Texto" }, advanced: { ...baseConfig.advanced, restrictions: "Sem preços" } };
    const saved = finalizeConfigForSave(withTexts, "support");
    expect(saved.knowledge.companyInfo).toBe("Texto");
    expect(saved.advanced.restrictions).toBe("Sem preços");
    const blank = finalizeConfigForSave({ ...baseConfig, knowledge: { ...baseConfig.knowledge, companyInfo: "  " }, advanced: { ...baseConfig.advanced, restrictions: "" } }, "support");
    expect("companyInfo" in blank.knowledge).toBe(false);
    expect("restrictions" in blank.advanced).toBe(false);
    // limpar o campo conta como alteração; deixar vazio não
    expect(configFingerprint(withTexts, "support")).not.toBe(configFingerprint(baseConfig, "support"));
    expect(configFingerprint({ ...baseConfig, knowledge: { ...baseConfig.knowledge, companyInfo: "" } }, "support")).toBe(configFingerprint(baseConfig, "support"));
  });

  it("finalizeConfigForSave limpa exemplos em branco e omite o formulário vazio", () => {
    const config: AgentConfig = {
      ...baseConfig,
      knowledge: { ...baseConfig.knowledge, examples: [{ customer: " a ", agent: " b " }, { customer: "", agent: "" }] },
      generator: { purpose: "support", companyText: "" },
    };
    const saved = finalizeConfigForSave(config, "support");
    expect(saved.knowledge.examples).toEqual([{ customer: "a", agent: "b" }]);
    expect("generator" in saved).toBe(false);
    expect(agentConfigSchema.safeParse(saved).success).toBe(true);
  });

  it("a impressão digital ignora o que não é alteração (sem exemplos = lista vazia; espaços; formulário vazio)", () => {
    const withEmpty: AgentConfig = { ...baseConfig, knowledge: { ...baseConfig.knowledge, examples: [] }, generator: { purpose: "support", companyText: "  " } };
    expect(configFingerprint(withEmpty, "support")).toBe(configFingerprint(baseConfig, "support"));
    const typed = setFormField(baseConfig, "support", "companyText", "Texto da empresa");
    expect(configFingerprint(typed, "support")).not.toBe(configFingerprint(baseConfig, "support"));
    expect(configFingerprint(setFormField(typed, "support", "companyText", "Texto da empresa  "), "support")).toBe(configFingerprint(typed, "support"));
  });

  it("para salvar, só o tamanho dos campos importa (texto curto da empresa não impede salvar)", () => {
    expect(limitErrors(formFromConfig(setFormField(baseConfig, "support", "companyText", "curto"), "support"))).toEqual({});
    const over = setFormField(baseConfig, "support", "restrictions", "a".repeat(GENERATOR_LIMITS.restrictions + 1));
    expect(limitErrors(formFromConfig(over, "support")).restrictions).toMatch(/Passou do limite/);
  });

  it("valida a config em edição com as regras do contrato", () => {
    const config = setFormField(baseConfig, "support", "companyText", "curto");
    expect(validateGeneratorForm(formFromConfig(config, "support")).companyText).toMatch(/pelo menos 50 caracteres/);
    expect(validateGeneratorForm(formFromConfig(setFormField(config, "support", "agentName", " "), "support")).agentName).toBeDefined();
    const withCompany = setFormField(baseConfig, "support", "companyText", COMPANY);
    expect(validateGeneratorForm(formFromConfig(withCompany, "support"))).toEqual({});
  });
});

describe("itens para completar (missingFields → extras → nova entrada)", () => {
  const values = defaultGeneratorForm({ agentName: "Duda", companyText: COMPANY });
  const output = agentGeneratorOutputSchema.parse({
    description: "Recebe clientes.",
    instructions: "Você é a Duda.",
    companySummary: "A Nexora faz sites.",
    companyInfo: "Sobre a empresa\nA Nexora faz sites.",
    examples: Array.from({ length: 8 }, (_, i) => ({ customer: `P${i}`, agent: `R${i}` })),
    warnings: ["Formas de pagamento não informadas.", "O horário de atendimento não foi informado.", "O prazo médio de entrega não está claro."],
    missingFields: ["paymentMethods", "hours"],
  });

  it("os campos de extras são os do contrato", () => {
    expect([...GENERATOR_EXTRA_FIELDS]).toEqual([...GENERATOR_MISSING_FIELD_KEYS]);
  });

  it("mostra só o que o gerador apontou e o formulário ainda não tem", () => {
    expect(pendingMissingFields(output.missingFields, values)).toEqual(["paymentMethods", "hours"]);
    expect(pendingMissingFields(output.missingFields, { ...values, hours: "8h às 18h" })).toEqual(["paymentMethods"]);
    expect(pendingMissingFields(undefined, values)).toEqual([]);
    expect(pendingMissingFields([], values)).toEqual([]);
  });

  it("avisos que viraram campo somem das notas; os outros ficam como nota simples", () => {
    expect(noteWarnings(output.warnings, output.missingFields)).toEqual(["O prazo médio de entrega não está claro."]);
    expect(noteWarnings(output.warnings, undefined)).toEqual(output.warnings);
    expect(viewOutcome(output, values)).toEqual({ missing: ["paymentMethods", "hours"], notes: ["O prazo médio de entrega não está claro."] });
  });

  it("só conta como preenchido o extra com texto", () => {
    expect(filledExtras({ hours: "  ", paymentMethods: "Pix" })).toEqual(["paymentMethods"]);
    expect(filledExtras({})).toEqual([]);
  });

  it("junta os extras ao formulário guardado e gera uma entrada válida (um clique)", () => {
    const merged = mergeExtras(values, { paymentMethods: " Pix e cartão ", hours: "" });
    expect(merged.paymentMethods).toBe("Pix e cartão");
    expect(merged.hours).toBe("");
    const input = formToInput(merged);
    expect(input.paymentMethods).toBe("Pix e cartão");
    expect("hours" in input).toBe(false);
    expect(agentGeneratorInputSchema.safeParse(input).success).toBe(true);
  });

  it("se o campo já tinha texto, o extra entra numa nova linha (sem apagar nem repetir)", () => {
    expect(mergeExtras({ ...values, hours: "seg a sex" }, { hours: "sábado até 12h" }).hours).toBe("seg a sex\nsábado até 12h");
    expect(mergeExtras({ ...values, hours: "seg a sex" }, { hours: "seg a sex" }).hours).toBe("seg a sex");
  });

  it("extra acima do limite do campo é barrado pela validação do formulário", () => {
    const merged = mergeExtras(values, { hours: "a".repeat(GENERATOR_LIMITS.hours + 1) });
    expect(validateGeneratorForm(merged).hours).toMatch(/Passou do limite/);
  });

  it("grava os extras na config para o formulário guardado refletir o que foi usado", () => {
    const config = setFormField(baseConfig, "support", "companyText", COMPANY);
    const next = applyExtrasToConfig(config, "support", { paymentMethods: "Pix", hours: "   " });
    expect(next.generator?.paymentMethods).toBe("Pix");
    expect(next.generator?.hours).toBeUndefined();
    expect(next.generator?.companyText).toBe(COMPANY);
    expect(applyExtrasToConfig(config, "support", {})).toBe(config);
  });

  it("quem informa um extra depois de gerar não vê o item de novo", () => {
    const config = applyExtrasToConfig(setFormField(baseConfig, "support", "companyText", COMPANY), "support", { hours: "8h às 18h" });
    expect(pendingMissingFields(["hours", "location"], formFromConfig(config, "support"))).toEqual(["location"]);
  });
});

describe("seções do editor (modelo MillionZap)", () => {
  it("são três: simples, avançada e recursos; a padrão é a simples", () => {
    expect(EDITOR_SECTIONS.map((t) => t.label)).toEqual(["Configuração simples", "Configuração avançada", "Recursos"]);
    expect(parseEditorSection(null)).toBe("simples");
    expect(parseEditorSection("avancada")).toBe("avancada");
    expect(parseEditorSection("recursos")).toBe("recursos");
    expect(AFTER_GENERATION_SECTION).toBe("avancada");
  });

  it("links antigos abrem o lugar para onde a função foi", () => {
    for (const old of ["prompt", "dados", "conhecimento", "avancado"]) expect(parseEditorSection(old)).toBe("avancada");
    for (const old of ["comportamento", "follow-up", "agenda"]) expect(parseEditorSection(old)).toBe("recursos");
    expect(parseEditorSection("perfil")).toBe("simples");
    expect(parseEditorSection("qualquer")).toBe("simples");
  });

  it("links antigos de recursos abrem o cartão certo (agenda e follow-up não são mais cartões)", () => {
    expect(legacyResource("agenda")).toBeNull();
    expect(legacyResource("follow-up")).toBeNull();
    expect(legacyResource("comportamento")).toBe("rules");
    expect(legacyResource("avancada")).toBeNull();
    expect(legacyResource(null)).toBeNull();
  });
});
