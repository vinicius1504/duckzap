import { AGENT_OBJECTIVE_SUGGESTIONS, AGENT_RESTRICTION_SUGGESTIONS, agentGeneratorInputSchema } from "@duckzap/contracts/agents";
import { describe, expect, it } from "vitest";
import {
  GENERATOR_LIMITS,
  GENERATOR_TEXT_FIELDS,
  SELECTABLE_PURPOSES,
  SIMPLE_FIELDS,
  SIMPLE_SECTIONS,
  addLine,
  blockerSentence,
  defaultGeneratorForm,
  displayPurpose,
  firstErrorField,
  formToInput,
  formatElapsed,
  generationBlockers,
  hasLine,
  mapGenerateFailure,
  phaseAt,
  purposeForJob,
  removeLine,
  simpleSectionNeedsAttention,
  storedExtraLabels,
  suggestFieldForWarning,
  toggleLine,
  validateGeneratorForm,
} from "./agent-generator";

const valid = defaultGeneratorForm({
  agentName: "Duda",
  companyText: "A Nexora faz sites e sistemas sob medida para pequenas empresas.",
});

describe("formToInput", () => {
  it("apara o texto e tira os opcionais vazios", () => {
    const input = formToInput({ ...valid, agentName: "  Duda ", sells: "   ", hours: " seg a sex, 8h às 18h ", restrictions: "" });
    expect(input).toEqual({
      purpose: "reception",
      agentName: "Duda",
      tone: "friendly",
      companyText: "A Nexora faz sites e sistemas sob medida para pequenas empresas.",
      hours: "seg a sex, 8h às 18h",
    });
    expect("sells" in input).toBe(false);
  });

  it("gera uma entrada que o contrato aceita", () => {
    const full = defaultGeneratorForm({ ...valid, sells: "Sites", doesNotSell: "Hardware", paymentMethods: "Pix", location: "Recife", budgetProcess: "Pelo comercial", askBeforeHandoff: "Nome", handoffRules: "Reclamação", restrictions: "Nunca mencionar preços", customInstructions: "Ser cordial" });
    expect(agentGeneratorInputSchema.safeParse(formToInput(full)).success).toBe(true);
  });
});

describe("validateGeneratorForm", () => {
  it("aceita um formulário válido", () => {
    expect(validateGeneratorForm(valid)).toEqual({});
  });

  it("exige nome", () => {
    expect(validateGeneratorForm({ ...valid, agentName: "  " }).agentName).toBe("Dê um nome para o agente.");
  });

  it("o essencial é obrigatório: nome e informações da empresa com 50+ caracteres (regra da tela)", () => {
    const base = defaultGeneratorForm({ agentName: "Duda" });
    expect(validateGeneratorForm(base).companyText).toMatch(/pelo menos 50 caracteres/);
    // 20 caracteres bastam para o contrato, mas não para a tela
    const twenty = { ...base, companyText: "a".repeat(20) };
    expect(agentGeneratorInputSchema.safeParse(formToInput(twenty)).success).toBe(true);
    expect(validateGeneratorForm(twenty).companyText).toMatch(/faltam 30/);
    expect(validateGeneratorForm({ ...base, companyText: "a".repeat(49) }).companyText).toMatch(/faltam 1\)/);
    expect(validateGeneratorForm({ ...base, companyText: "a".repeat(50) })).toEqual({});
  });

  it("'o que vende' não é mais exigido", () => {
    expect(validateGeneratorForm(valid).sells).toBeUndefined();
    expect(validateGeneratorForm(valid)).toEqual({});
  });

  it("os campos opcionais não são obrigatórios", () => {
    expect(validateGeneratorForm(valid)).toEqual({});
  });

  it("conta o texto aparado, como o contrato", () => {
    expect(validateGeneratorForm({ ...valid, companyText: `${" ".repeat(60)}curto${" ".repeat(60)}` }).companyText).toBeDefined();
  });

  it("os limites daqui são os do contrato: no limite passa, 1 acima falha", () => {
    for (const field of GENERATOR_TEXT_FIELDS) {
      const limit = GENERATOR_LIMITS[field];
      const atLimit = { ...valid, [field]: "a".repeat(limit) };
      expect(validateGeneratorForm(atLimit)[field], `${field} no limite`).toBeUndefined();
      expect(agentGeneratorInputSchema.safeParse(formToInput(atLimit)).success, `${field} contrato no limite`).toBe(true);
      const over = { ...valid, [field]: "a".repeat(limit + 1) };
      expect(validateGeneratorForm(over)[field], `${field} acima`).toMatch(/Passou do limite/);
      expect(agentGeneratorInputSchema.safeParse(formToInput(over)).success, `${field} contrato acima`).toBe(false);
    }
  });

  it("firstErrorField segue a ordem da tela", () => {
    expect(firstErrorField({ restrictions: "x", companyText: "y" })).toBe("companyText");
    expect(firstErrorField({ hours: "x", restrictions: "y" })).toBe("restrictions");
    expect(firstErrorField({})).toBeNull();
  });
});

describe("chips de sugestão", () => {
  const line = "Nunca mencionar preços";

  it("acrescenta em nova linha e reconhece a linha já usada", () => {
    expect(addLine("", line, 1000)).toBe(line);
    expect(addLine("Ser cordial", line, 1000)).toBe(`Ser cordial\n${line}`);
    expect(addLine(`${line}.`, line, 1000)).toBe(`${line}.`);
    expect(hasLine("- nunca mencionar preços;", line)).toBe(true);
    expect(hasLine("Nunca mencionar preços de produtos", line)).toBe(false);
  });

  it("não acrescenta se estourar o limite do campo", () => {
    expect(addLine("a".repeat(990), line, 1000)).toBeNull();
    expect(addLine("a".repeat(900), line, 1000)).not.toBeNull();
  });

  it("remove só a linha da sugestão", () => {
    expect(removeLine(`Ser cordial\n${line}\nOutra regra`, line)).toBe("Ser cordial\nOutra regra");
    expect(removeLine(line, line)).toBe("");
  });

  it("toggle marca e desmarca", () => {
    const on = toggleLine("Regra minha", line, 1000);
    expect(on).toBe(`Regra minha\n${line}`);
    expect(toggleLine(on ?? "", line, 1000)).toBe("Regra minha");
    expect(toggleLine("a".repeat(995), line, 1000)).toBeNull();
  });

  it("todas as sugestões do contrato cabem juntas nos limites dos campos", () => {
    expect(AGENT_RESTRICTION_SUGGESTIONS.join("\n").length).toBeLessThanOrEqual(GENERATOR_LIMITS.restrictions);
    expect(AGENT_OBJECTIVE_SUGGESTIONS.join("\n").length).toBeLessThanOrEqual(GENERATOR_LIMITS.customInstructions);
  });
});

describe("finalidade inicial pelo trabalho do agente", () => {
  it("mapeia o trabalho para a finalidade sugerida", () => {
    expect(purposeForJob("scheduling")).toBe("reception");
    expect(purposeForJob("follow_up")).toBe("sales");
    expect(purposeForJob("support")).toBe("support");
    expect(purposeForJob("instagram_dm")).toBe("support");
  });
});

describe("finalidades oferecidas (sem 'Agendamento')", () => {
  it("a tela oferece Recepção, Vendas/SDR e Suporte", () => {
    expect([...SELECTABLE_PURPOSES]).toEqual(["reception", "sales", "support"]);
  });

  it("agente antigo com 'Agendamento' mostra Recepção, sem apagar o valor guardado", () => {
    expect(displayPurpose("scheduling")).toBe("reception");
    for (const purpose of SELECTABLE_PURPOSES) expect(displayPurpose(purpose)).toBe(purpose);
    const stored = { purpose: "scheduling" as const, companyText: "Texto da empresa" };
    expect(agentGeneratorInputSchema.safeParse({ ...formToInput(defaultGeneratorForm({ agentName: "Duda", companyText: "x".repeat(60) })), purpose: stored.purpose }).success).toBe(true);
  });
});

describe("suggestFieldForWarning", () => {
  it("aponta o campo que resolve o aviso", () => {
    expect(suggestFieldForWarning("Não foram informadas as formas de pagamento")).toBe("paymentMethods");
    expect(suggestFieldForWarning("O horário de atendimento não foi informado")).toBe("hours");
    expect(suggestFieldForWarning("Falta o endereço ou a cidade")).toBe("location");
    expect(suggestFieldForWarning("Não está claro como funciona o orçamento")).toBe("budgetProcess");
    expect(suggestFieldForWarning("Nada a ver")).toBeNull();
  });
});

describe("progresso", () => {
  it("o texto muda com o tempo e nunca mostra porcentagem", () => {
    expect(phaseAt(0).label).toMatch(/Lendo/);
    expect(phaseAt(10).label).toMatch(/Organizando/);
    expect(phaseAt(20).label).toMatch(/exemplos/);
    expect(phaseAt(60).label).toMatch(/Ainda trabalhando/);
    expect(phaseAt(130).label).toMatch(/demorando/);
    expect(phaseAt(130).label).not.toMatch(/%/);
  });

  it("formata o tempo decorrido", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(83.9)).toBe("1:23");
    expect(formatElapsed(-4)).toBe("0:00");
  });
});

describe("mapGenerateFailure", () => {
  const body = (code: string, extra: object = {}) => ({ error: { code, message: "msg do servidor", ...extra } });

  it("422 mantém os campos conhecidos e descarta os desconhecidos", () => {
    const result = mapGenerateFailure(422, body("invalid_input", { message: 'Campo "texto da empresa": curto', fields: { companyText: "Muito curto", inventado: "x" } }));
    expect(result.code).toBe("invalid_input");
    expect(result.fields).toEqual({ companyText: "Muito curto" });
    expect(result.message).toContain("texto da empresa");
    expect(result.retryable).toBe(false);
  });

  it("429 sugere esperar (padrão 1 min; usa Retry-After quando vier)", () => {
    expect(mapGenerateFailure(429, body("rate_limited"))).toMatchObject({ code: "rate_limited", retryAfterSeconds: 60, retryable: true });
    expect(mapGenerateFailure(429, body("rate_limited"), "30").retryAfterSeconds).toBe(30);
    expect(mapGenerateFailure(429, body("rate_limited"), "abc").retryAfterSeconds).toBe(60);
  });

  it("402 não oferece tentar de novo (vai para o plano)", () => {
    expect(mapGenerateFailure(402, body("budget_exceeded"))).toMatchObject({ code: "budget_exceeded", retryable: false });
  });

  it("503 e 502 oferecem tentar de novo", () => {
    expect(mapGenerateFailure(503, body("ai_unavailable"))).toMatchObject({ code: "ai_unavailable", retryable: true });
    expect(mapGenerateFailure(502, body("generation_failed"))).toMatchObject({ code: "generation_failed", retryable: true });
  });

  it("sessão e suspensão viram 'gate' para a tela redirecionar", () => {
    expect(mapGenerateFailure(401, null).gate).toBe("login");
    expect(mapGenerateFailure(403, body("account_suspended")).gate).toBe("suspended");
    expect(mapGenerateFailure(403, body("two_factor_required")).gate).toBe("two_factor");
    const plain = mapGenerateFailure(403, body("forbidden"));
    expect(plain).toMatchObject({ code: "forbidden", retryable: false });
    expect(plain.gate).toBeUndefined();
  });

  it("corpo ilegível ou erro desconhecido vira 'indisponível', com a mensagem em português", () => {
    for (const result of [mapGenerateFailure(500, null), mapGenerateFailure(504, "x"), mapGenerateFailure(418, body("teapot"))]) {
      expect(result).toMatchObject({ code: "unavailable", retryable: true });
      expect(result.message).toMatch(/servidor/);
    }
  });
});

describe("o que impede de gerar (motivo embaixo do botão)", () => {
  it("lista cada falta na ordem da tela, com o que falta", () => {
    const blockers = generationBlockers(defaultGeneratorForm({ companyText: "a".repeat(40) }));
    expect(blockers.map((b) => b.field)).toEqual(["agentName", "companyText"]);
    expect(blockers[0]?.detail).toBe("obrigatório");
    expect(blockers[1]?.detail).toBe("faltam 10 caracteres");
    expect(blockerSentence(blockers)).toBe("Para gerar o prompt, ainda falta: Nome do agente (obrigatório); Informações da empresa (faltam 10 caracteres).");
  });

  it("campo acima do limite também bloqueia, e sem faltas não há frase", () => {
    const over = { ...valid, restrictions: "a".repeat(GENERATOR_LIMITS.restrictions + 1) };
    expect(generationBlockers(over)).toEqual([{ field: "restrictions", label: "O que a IA NÃO deve fazer?", detail: "passou do limite de caracteres" }]);
    expect(generationBlockers(valid)).toEqual([]);
    expect(blockerSentence([])).toBeNull();
  });
});

describe("sub-abas do formulário simples", () => {
  it("são três, uma por texto, e só 'Informações da empresa' é obrigatória", () => {
    expect(SIMPLE_SECTIONS.map((section) => [section.label, section.field, section.required])).toEqual([
      ["Informações da empresa", "companyText", true],
      ["Objetivos / instruções", "customInstructions", false],
      ["Restrições", "restrictions", false],
    ]);
  });

  it("a sub-aba obrigatória incompleta mostra o indicador; as opcionais só quando têm erro", () => {
    expect(simpleSectionNeedsAttention("company", defaultGeneratorForm({ companyText: "curto" }))).toBe(true);
    expect(simpleSectionNeedsAttention("company", valid)).toBe(false);
    expect(simpleSectionNeedsAttention("goals", valid)).toBe(false);
    expect(simpleSectionNeedsAttention("restrictions", valid, { restrictions: "Passou do limite" })).toBe(true);
    expect(simpleSectionNeedsAttention("company", valid, { companyText: "erro do servidor" })).toBe(true);
  });
});

describe("extras guardados fora do formulário simples", () => {
  it("o formulário não tem mais campos de 'o que vende', pagamento, horário etc.: só os extras guardados valem na geração", () => {
    expect([...SIMPLE_FIELDS]).toEqual(["agentName", "companyText", "customInstructions", "restrictions"]);
    const input = formToInput({ ...valid, hours: "8h às 18h", askBeforeHandoff: "Nome", sells: "Sites" });
    expect(input).toMatchObject({ hours: "8h às 18h", askBeforeHandoff: "Nome", sells: "Sites" });
    expect(agentGeneratorInputSchema.safeParse(input).success).toBe(true);
  });

  it("lista os nomes dos extras preenchidos (para a tela dizer que eles continuam valendo)", () => {
    const base = { purpose: "support" as const, companyText: "texto" };
    expect(storedExtraLabels(undefined)).toEqual([]);
    expect(storedExtraLabels({ ...base, restrictions: "x", customInstructions: "y" })).toEqual([]);
    expect(storedExtraLabels({ ...base, hours: "8h", paymentMethods: " Pix ", location: "  " })).toEqual(["Formas de pagamento", "Horário de atendimento"]);
  });
});
