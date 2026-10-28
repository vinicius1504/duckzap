import { GENERATOR_COMPANY_TEXT_MAX, GENERATOR_MISSING_FIELD_KEYS, agentGeneratorInputSchema, type AgentGeneratorInput, type AgentGeneratorOutput, type AgentGeneratorPurpose, type AgentGeneratorStored, type AgentJob, type AgentTone, type GeneratorMissingField, type AgentConfig } from "@duckzap/contracts/agents";
import { cleanExamples } from "./agent-examples";

// Gerador de perfil do agente: lógica pura da tela. A configuração em edição (`AgentConfig`) é a única fonte de verdade do
// formulário: nome em `config.name`, modo em `config.profile.tone`, o resto em `config.generator`. Aqui ficam o mapeamento
// config ↔ formulário ↔ entrada da API, os chips de sugestão, os "itens para completar", o progresso e o mapeamento de
// erros. Sem React e sem rede: tudo testável em `agent-generator.test.ts`.

// ---------- formulário ----------

/** Campos de texto do formulário, na ordem da tela (`askBeforeHandoff` não tem campo na tela, mas é preservado). */
export const GENERATOR_TEXT_FIELDS = [
  "agentName",
  "companyText",
  "customInstructions",
  "restrictions",
  "sells",
  "doesNotSell",
  "paymentMethods",
  "hours",
  "location",
  "budgetProcess",
  "askBeforeHandoff",
  "handoffRules",
] as const;
export type GeneratorTextField = (typeof GENERATOR_TEXT_FIELDS)[number];
export type GeneratorField = GeneratorTextField | "purpose" | "tone";

/** Limites iguais aos do contrato (`agentGeneratorInputSchema`); o teste confere os dois lados. */
export const GENERATOR_LIMITS: Record<GeneratorTextField, number> = {
  agentName: 60,
  companyText: GENERATOR_COMPANY_TEXT_MAX,
  customInstructions: 2000,
  restrictions: 1000,
  sells: 1500,
  doesNotSell: 800,
  paymentMethods: 500,
  hours: 400,
  location: 400,
  budgetProcess: 1000,
  askBeforeHandoff: 600,
  handoffRules: 1000,
};

/** Campos que o gerador pode apontar como ausentes (cada um vira um campo em "Complete para melhorar"). */
export const GENERATOR_EXTRA_FIELDS: readonly GeneratorMissingField[] = GENERATOR_MISSING_FIELD_KEYS;

export const GENERATOR_FIELD_LABELS: Record<GeneratorTextField, string> = {
  agentName: "Nome do agente",
  companyText: "Informações da empresa",
  customInstructions: "O que a IA deve fazer?",
  restrictions: "O que a IA NÃO deve fazer?",
  sells: "O que você vende",
  doesNotSell: "O que você NÃO vende",
  paymentMethods: "Formas de pagamento",
  hours: "Horário de atendimento",
  location: "Localização",
  budgetProcess: "Como funciona o orçamento",
  askBeforeHandoff: "O que perguntar antes de transferir",
  handoffRules: "Quando passar para uma pessoa",
};

/** Exemplo mostrado dentro de cada campo de "Complete para melhorar". */
export const EXTRA_PLACEHOLDERS: Record<GeneratorMissingField, string> = {
  sells: "Ex.: Pães artesanais, bolos por encomenda, café e lanches.",
  doesNotSell: "Ex.: Não vendemos produtos sem glúten nem entregamos fora da cidade.",
  paymentMethods: "Ex.: Pix, cartão de crédito em até 3x e dinheiro.",
  hours: "Ex.: Segunda a sexta, das 8h às 18h; sábado, das 8h às 12h.",
  location: "Ex.: Rua das Flores, 120, Centro. Entregamos na região metropolitana.",
  budgetProcess: "Ex.: O orçamento é feito pelo comercial depois que o cliente conta o que precisa e o prazo.",
  handoffRules: "Ex.: Quando o cliente pedir para falar com uma pessoa, reclamar ou pedir desconto.",
};

export const PURPOSE_HELP: Record<AgentGeneratorPurpose, string> = {
  reception: "Recebe o cliente, entende o que ele precisa e encaminha para o setor ou a pessoa certa.",
  sales: "Apresenta o que você vende, entende o interesse do cliente e conduz até o orçamento ou a compra.",
  support: "Tira as dúvidas mais comuns e resolve o básico; chama uma pessoa quando o caso é mais complexo.",
  scheduling: "Oferece horários, marca e remarca atendimentos.",
};

export const TONE_HELP: Record<AgentTone, string> = {
  friendly: "Acolhedor e próximo, com linguagem simples.",
  formal: "Respeitoso e profissional, sem gírias.",
  direct: "Objetivo e curto, vai direto ao ponto.",
};

export type GeneratorFormValues = {
  purpose: AgentGeneratorPurpose;
  tone: AgentTone;
} & Record<GeneratorTextField, string>;

export function defaultGeneratorForm(overrides: Partial<GeneratorFormValues> = {}): GeneratorFormValues {
  return {
    purpose: "reception",
    tone: "friendly",
    agentName: "",
    companyText: "",
    customInstructions: "",
    restrictions: "",
    sells: "",
    doesNotSell: "",
    paymentMethods: "",
    hours: "",
    location: "",
    budgetProcess: "",
    askBeforeHandoff: "",
    handoffRules: "",
    ...overrides,
  };
}

/**
 * Finalidades que a tela oferece. "Agendamento" saiu: qualquer agente marca horários sozinho quando há tipos de atendimento
 * na Agenda. O valor `scheduling` continua válido no contrato e em agentes antigos.
 */
export const SELECTABLE_PURPOSES = ["reception", "sales", "support"] as const satisfies readonly AgentGeneratorPurpose[];
export type SelectablePurpose = (typeof SELECTABLE_PURPOSES)[number];

/** Finalidade mostrada na tela: a guardada, ou a mais próxima (Recepção) quando é a antiga "Agendamento". O valor guardado não muda. */
export function displayPurpose(purpose: AgentGeneratorPurpose): SelectablePurpose {
  return purpose === "scheduling" ? "reception" : purpose;
}

/** Finalidade inicial para um agente que ainda não guardou o formulário (vem do trabalho dele). */
export function purposeForJob(job: AgentJob): AgentGeneratorPurpose {
  if (job === "scheduling") return "reception";
  if (job === "follow_up") return "sales";
  return "support";
}

// ---------- configuração em edição ↔ formulário ----------

/** Campos de `config.generator` além de `purpose` e `companyText`. */
const STORED_OPTIONAL_FIELDS = [
  "customInstructions",
  "restrictions",
  "sells",
  "doesNotSell",
  "paymentMethods",
  "hours",
  "location",
  "budgetProcess",
  "askBeforeHandoff",
  "handoffRules",
] as const satisfies readonly (keyof AgentGeneratorStored)[];

/** O formulário como a tela o mostra: nome e modo vêm da config; o resto vem de `config.generator` (ausente = vazio). */
export function formFromConfig(config: AgentConfig, fallbackPurpose: AgentGeneratorPurpose): GeneratorFormValues {
  const stored = config.generator;
  return defaultGeneratorForm({
    purpose: stored?.purpose ?? fallbackPurpose,
    tone: config.profile.tone,
    agentName: config.name,
    companyText: stored?.companyText ?? "",
    ...Object.fromEntries(STORED_OPTIONAL_FIELDS.map((field) => [field, stored?.[field] ?? ""])),
  });
}

/** Troca um campo do formulário na config. Nome e modo vão para os lugares deles; o resto cria/atualiza `config.generator`. */
export function setFormField(config: AgentConfig, fallbackPurpose: AgentGeneratorPurpose, field: GeneratorField, value: string): AgentConfig {
  if (field === "agentName") return { ...config, name: value };
  if (field === "tone") return { ...config, profile: { ...config.profile, tone: isTone(value) ? value : config.profile.tone } };
  const base: AgentGeneratorStored = config.generator ?? { purpose: fallbackPurpose, companyText: "" };
  if (field === "purpose") return { ...config, generator: { ...base, purpose: isPurpose(value) ? value : base.purpose } };
  return { ...config, generator: { ...base, [field]: value } };
}

function isTone(value: string): value is AgentTone {
  return value === "friendly" || value === "formal" || value === "direct";
}
function isPurpose(value: string): value is AgentGeneratorPurpose {
  return value === "reception" || value === "sales" || value === "support" || value === "scheduling";
}

/**
 * `config.generator` pronto para guardar: textos aparados, opcionais vazios fora. `undefined` quando não há nada a lembrar
 * (sem texto nenhum e com a finalidade que o trabalho do agente já sugere).
 */
export function normalizeStoredGenerator(stored: AgentGeneratorStored | undefined, fallbackPurpose: AgentGeneratorPurpose): AgentGeneratorStored | undefined {
  if (!stored) return undefined;
  const next: AgentGeneratorStored = { purpose: stored.purpose, companyText: stored.companyText.trim() };
  let hasText = next.companyText.length > 0;
  for (const field of STORED_OPTIONAL_FIELDS) {
    const value = stored[field]?.trim();
    if (value) {
      next[field] = value;
      hasText = true;
    }
  }
  return hasText || next.purpose !== fallbackPurpose ? next : undefined;
}

/**
 * O que vai para a versão salva: exemplos em branco saem, o formulário guardado é normalizado e os textos novos
 * (`companyInfo`, `restrictions`) vazios não viram campo.
 */
export function finalizeConfigForSave(config: AgentConfig, fallbackPurpose: AgentGeneratorPurpose): AgentConfig {
  const { generator, ...rest } = config;
  const { companyInfo, ...knowledge } = rest.knowledge;
  const { restrictions, ...advanced } = rest.advanced;
  const normalized = normalizeStoredGenerator(generator, fallbackPurpose);
  return {
    ...rest,
    knowledge: { ...knowledge, examples: cleanExamples(knowledge.examples ?? []), ...(companyInfo?.trim() ? { companyInfo } : {}) },
    advanced: { ...advanced, ...(restrictions?.trim() ? { restrictions } : {}) },
    ...(normalized ? { generator: normalized } : {}),
  };
}

/** Compara configurações: "sem exemplos" = "lista vazia", e o formulário guardado vale pelo que tem de conteúdo. */
export function configFingerprint(config: AgentConfig, fallbackPurpose: AgentGeneratorPurpose): string {
  return JSON.stringify(finalizeConfigForSave(config, fallbackPurpose));
}

/** Valores do formulário → corpo de `POST /v1/agents/generate` (texto aparado; opcionais vazios saem). */
export function formToInput(values: GeneratorFormValues): AgentGeneratorInput {
  const optional = (value: string) => {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };
  const input: AgentGeneratorInput = {
    purpose: values.purpose,
    agentName: values.agentName.trim(),
    tone: values.tone,
    companyText: values.companyText.trim(),
  };
  for (const field of STORED_OPTIONAL_FIELDS) {
    const value = optional(values[field]);
    if (value !== undefined) input[field] = value;
  }
  return input;
}

// ---------- "Complete para melhorar" ----------

export type GeneratorExtras = Partial<Record<GeneratorMissingField, string>>;

/** Extras que têm texto (aparado), na ordem do contrato. */
export function filledExtras(extras: GeneratorExtras): GeneratorMissingField[] {
  return GENERATOR_EXTRA_FIELDS.filter((field) => (extras[field] ?? "").trim().length > 0);
}

/**
 * Junta os extras ao formulário guardado. O gerador só aponta o que faltou em TODOS os dados, então o campo costuma estar
 * vazio; se o dono preencheu no meio-tempo, o extra entra numa nova linha em vez de apagar o que ele escreveu.
 */
export function mergeExtras(values: GeneratorFormValues, extras: GeneratorExtras): GeneratorFormValues {
  const next = { ...values };
  for (const field of filledExtras(extras)) {
    const extra = (extras[field] ?? "").trim();
    const current = values[field].trim();
    next[field] = current ? (current.includes(extra) ? current : `${current}\n${extra}`) : extra;
  }
  return next;
}

/** A mesma junção, gravada na config (para o formulário guardado já refletir o que foi usado na geração). */
export function applyExtrasToConfig(config: AgentConfig, fallbackPurpose: AgentGeneratorPurpose, extras: GeneratorExtras): AgentConfig {
  const merged = mergeExtras(formFromConfig(config, fallbackPurpose), extras);
  let next = config;
  for (const field of filledExtras(extras)) next = setFormField(next, fallbackPurpose, field, merged[field]);
  return next;
}

/** Itens que ainda aparecem em "Complete para melhorar": os que o gerador apontou e que o formulário ainda não tem. */
export function pendingMissingFields(missing: readonly GeneratorMissingField[] | undefined, values: GeneratorFormValues): GeneratorMissingField[] {
  return GENERATOR_EXTRA_FIELDS.filter((field) => (missing ?? []).includes(field) && !values[field].trim());
}

/** Avisos em texto livre que NÃO viraram um campo estruturado: aparecem como notas. */
export function noteWarnings(warnings: readonly string[], missing: readonly GeneratorMissingField[] | undefined): string[] {
  const structured = new Set<GeneratorTextField>(missing ?? []);
  return warnings.filter((warning) => {
    const field = suggestFieldForWarning(warning);
    return field === null || !structured.has(field);
  });
}

export type GenerationOutcomeView = {
  missing: GeneratorMissingField[];
  notes: string[];
};

/** O que a tela mostra depois de gerar com `values` (já com os extras). */
export function viewOutcome(output: Pick<AgentGeneratorOutput, "warnings" | "missingFields">, values: GeneratorFormValues): GenerationOutcomeView {
  const missing = pendingMissingFields(output.missingFields, values);
  return { missing, notes: noteWarnings(output.warnings, output.missingFields) };
}

// ---------- validação ----------

export type GeneratorFieldErrors = Partial<Record<GeneratorField, string>>;

export function overLimitMessage(limit: number, length: number): string {
  const excess = length - limit;
  return `Passou do limite de ${formatCount(limit)} caracteres (${formatCount(excess)} a mais).`;
}

// ---------- o que a tela pede (formulário simples) e o que só aparece em "Complete para melhorar" ----------

/** A tela exige mais que o contrato (que aceita texto da empresa com 20+ caracteres OU "o que vende"): a IA funciona melhor assim. */
export const COMPANY_TEXT_MIN = 50;

export const ESSENTIAL_FIELDS = ["agentName", "companyText"] as const satisfies readonly GeneratorTextField[];
export type EssentialField = (typeof ESSENTIAL_FIELDS)[number];

/** Os três textos do formulário simples, um por sub-aba. */
export const SIMPLE_SECTIONS = [
  { id: "company", field: "companyText", label: "Informações da empresa", required: true },
  { id: "goals", field: "customInstructions", label: "Objetivos / instruções", required: false },
  { id: "restrictions", field: "restrictions", label: "Restrições", required: false },
] as const;
export type SimpleSectionId = (typeof SIMPLE_SECTIONS)[number]["id"];

/** Campos do formulário simples (o resto de `config.generator` só nasce em "Complete para melhorar"). */
export const SIMPLE_FIELDS = ["agentName", "companyText", "customInstructions", "restrictions"] as const satisfies readonly GeneratorTextField[];

/** Campos guardados que NÃO têm campo no formulário simples: continuam valendo na geração. */
export const STORED_EXTRA_FIELDS: readonly GeneratorTextField[] = [
  "sells",
  "doesNotSell",
  "paymentMethods",
  "hours",
  "location",
  "budgetProcess",
  "handoffRules",
  "askBeforeHandoff",
];

/** Nomes dos extras que o formulário guardado tem preenchidos ("Horário de atendimento", "Formas de pagamento"…). */
export function storedExtraLabels(stored: AgentGeneratorStored | undefined): string[] {
  if (!stored) return [];
  return STORED_EXTRA_FIELDS.filter((field) => ((stored as Record<string, unknown>)[field] as string | undefined)?.trim()).map((field) => GENERATOR_FIELD_LABELS[field]);
}

/** Sub-aba com problema: a obrigatória incompleta (ou qualquer erro de campo) ganha um ponto na aba. */
export function simpleSectionNeedsAttention(id: SimpleSectionId, values: GeneratorFormValues, errors: GeneratorFieldErrors = {}): boolean {
  const section = SIMPLE_SECTIONS.find((item) => item.id === id);
  if (!section) return false;
  if (errors[section.field] !== undefined) return true;
  return section.required && values[section.field].trim().length < COMPANY_TEXT_MIN;
}

/** Faltas do essencial, por campo, com a mensagem para o próprio campo. */
export function essentialIssues(values: GeneratorFormValues): Partial<Record<EssentialField, string>> {
  const issues: Partial<Record<EssentialField, string>> = {};
  if (!values.agentName.trim()) issues.agentName = "Dê um nome para o agente.";
  const company = values.companyText.trim().length;
  if (company < COMPANY_TEXT_MIN) {
    issues.companyText =
      company === 0
        ? `Fale sobre sua empresa: escreva pelo menos ${COMPANY_TEXT_MIN} caracteres.`
        : `Escreva um pouco mais sobre a empresa: pelo menos ${COMPANY_TEXT_MIN} caracteres (faltam ${COMPANY_TEXT_MIN - company}).`;
  }
  return issues;
}

/**
 * Validação da tela: o essencial (regra da tela) + os limites e regras do contrato, com mensagens em português por campo.
 * O limite de cada campo vem de `GENERATOR_LIMITS`. Quem decide se o botão "Gerar" fica ativo é esta função.
 */
export function validateGeneratorForm(values: GeneratorFormValues): GeneratorFieldErrors {
  const errors: GeneratorFieldErrors = { ...essentialIssues(values) };
  for (const field of GENERATOR_TEXT_FIELDS) {
    const length = values[field].trim().length;
    const limit = GENERATOR_LIMITS[field];
    if (length > limit) errors[field] = overLimitMessage(limit, length);
  }
  const parsed = agentGeneratorInputSchema.safeParse(formToInput(values));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === "too_big") continue;
      const field = String(issue.path[0] ?? "");
      if (isGeneratorField(field) && !errors[field]) errors[field] = issue.message;
    }
  }
  return errors;
}

/** O que impede de gerar, na ordem da tela: o campo, o nome dele e o que falta em poucas palavras. */
export function generationBlockers(values: GeneratorFormValues): { field: GeneratorField; label: string; detail: string }[] {
  const errors = validateGeneratorForm(values);
  const out: { field: GeneratorField; label: string; detail: string }[] = [];
  const order: GeneratorField[] = [...ESSENTIAL_FIELDS, ...GENERATOR_TEXT_FIELDS];
  for (const field of order) {
    if (errors[field] === undefined || out.some((item) => item.field === field)) continue;
    const label = GENERATOR_FIELD_LABELS[field as GeneratorTextField];
    const length = values[field as GeneratorTextField].trim().length;
    const min = field === "companyText" ? COMPANY_TEXT_MIN : 0;
    const limit = GENERATOR_LIMITS[field as GeneratorTextField];
    const detail = length > limit ? "passou do limite de caracteres" : min && length > 0 ? `faltam ${min - length} caracteres` : "obrigatório";
    out.push({ field, label, detail });
  }
  return out;
}

/** Frase embaixo do botão "Gerar" enquanto ele está desabilitado. `null` = pode gerar. */
export function blockerSentence(blockers: readonly { label: string; detail: string }[]): string | null {
  if (blockers.length === 0) return null;
  return `Para gerar o prompt, ainda falta: ${blockers.map((item) => `${item.label} (${item.detail})`).join("; ")}.`;
}

/** Só os erros de tamanho: é o que impede SALVAR o formulário guardado (as demais regras valem apenas para gerar). */
export function limitErrors(values: GeneratorFormValues): GeneratorFieldErrors {
  const errors: GeneratorFieldErrors = {};
  for (const field of GENERATOR_TEXT_FIELDS) {
    const length = values[field].trim().length;
    if (length > GENERATOR_LIMITS[field]) errors[field] = overLimitMessage(GENERATOR_LIMITS[field], length);
  }
  return errors;
}

export function isGeneratorField(value: string): value is GeneratorField {
  return value === "purpose" || value === "tone" || (GENERATOR_TEXT_FIELDS as readonly string[]).includes(value);
}

/** Primeiro campo com erro, na ordem da tela (para devolver o foco). */
export function firstErrorField(errors: GeneratorFieldErrors): GeneratorField | null {
  const order: GeneratorField[] = ["purpose", "agentName", "tone", "companyText", "customInstructions", "restrictions", ...STORED_EXTRA_FIELDS];
  return order.find((field) => errors[field] !== undefined) ?? null;
}

export function formatCount(n: number): string {
  return n.toLocaleString("pt-BR");
}

// ---------- chips de sugestão (objetivos e restrições) ----------

/** Compara linhas ignorando maiúsculas, marcador no início e ponto final. */
export function normalizeLine(line: string): string {
  return line
    .trim()
    .replace(/^[-•*]\s*/, "")
    .replace(/[.;]+\s*$/, "")
    .trim()
    .toLowerCase();
}

export function hasLine(text: string, line: string): boolean {
  const wanted = normalizeLine(line);
  return text.split(/\r?\n/).some((l) => normalizeLine(l) === wanted);
}

/** Acrescenta a sugestão em uma nova linha. `null` = não cabe no limite. Se já existe, devolve o texto como está. */
export function addLine(text: string, line: string, max: number): string | null {
  if (hasLine(text, line)) return text;
  const base = text.replace(/\s+$/, "");
  const next = base ? `${base}\n${line}` : line;
  return next.length > max ? null : next;
}

export function removeLine(text: string, line: string): string {
  const wanted = normalizeLine(line);
  return text
    .split(/\r?\n/)
    .filter((l) => normalizeLine(l) !== wanted)
    .join("\n")
    .replace(/^\s*\n+/, "")
    .replace(/\s+$/, "");
}

/** Clique no chip: marca (acrescenta) ou desmarca (remove). `null` = marcar não cabe no limite do campo. */
export function toggleLine(text: string, line: string, max: number): string | null {
  return hasLine(text, line) ? removeLine(text, line) : addLine(text, line, max);
}

// ---------- avisos do gerador → campo do formulário ----------

const WARNING_HINTS: { pattern: RegExp; field: GeneratorTextField }[] = [
  { pattern: /pagament|\bpix\b|cart[aã]o|boleto|parcel/i, field: "paymentMethods" },
  { pattern: /hor[aá]rio|funcionament|atendimento humano/i, field: "hours" },
  { pattern: /endere[cç]o|localiza|cidade|regi[aã]o|[aá]rea atendida/i, field: "location" },
  { pattern: /or[cç]amento|proposta|cota[cç][aã]o/i, field: "budgetProcess" },
  { pattern: /n[aã]o vend|n[aã]o ofere|n[aã]o fazem|n[aã]o trabalh/i, field: "doesNotSell" },
  { pattern: /transfer|chamar (uma )?pessoa|humano|equipe respons|encaminh/i, field: "handoffRules" },
  { pattern: /vend[ae]|produto|servi[cç]o|cat[aá]logo|card[aá]pio|pre[cç]o|valor/i, field: "sells" },
];

/** Palpite de qual campo do formulário resolveria o aviso. `null` quando não dá para saber. */
export function suggestFieldForWarning(warning: string): GeneratorTextField | null {
  return WARNING_HINTS.find((hint) => hint.pattern.test(warning))?.field ?? null;
}

// ---------- progresso da geração ----------

/** Estimativas: a API não informa em que etapa está, então o texto segue o tempo que passou, sem porcentagem. */
const PHASES: { from: number; label: string }[] = [
  { from: 0, label: "Lendo as informações da empresa…" },
  { from: 8, label: "Organizando o conhecimento…" },
  { from: 18, label: "Escrevendo exemplos de resposta…" },
  { from: 50, label: "Ainda trabalhando. Textos grandes levam mais tempo…" },
  { from: 100, label: "Está demorando mais que o normal, mas ainda não terminou…" },
];

export function phaseAt(elapsedSeconds: number): { index: number; label: string } {
  let index = 0;
  PHASES.forEach((phase, i) => {
    if (elapsedSeconds >= phase.from) index = i;
  });
  return { index, label: PHASES[index]?.label ?? "" };
}

/** 83 → "1:23" */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Tempo máximo que o navegador espera: o prazo da API é 270 s; esta margem cobre a ida e a volta. */
export const GENERATE_CLIENT_TIMEOUT_MS = 290_000;

// ---------- erros ----------

export type GenerateErrorCode =
  | "invalid_input"
  | "rate_limited"
  | "budget_exceeded"
  | "ai_unavailable"
  | "generation_failed"
  | "forbidden"
  | "timeout"
  | "unavailable";

/** A sessão ou a conta impede a chamada: a tela leva o usuário para onde o resto do app levaria. */
export type GenerateGate = "login" | "suspended" | "two_factor";

export type GenerateFailure = {
  code: GenerateErrorCode;
  message: string;
  /** Faz sentido mostrar "Tentar de novo". */
  retryable: boolean;
  /** 422: mensagem por campo do formulário. */
  fields?: GeneratorFieldErrors;
  /** 429: segundos de espera sugeridos. */
  retryAfterSeconds?: number;
  gate?: GenerateGate;
};

const MESSAGES: Record<GenerateErrorCode, string> = {
  invalid_input: "Confira os campos destacados e tente de novo.",
  rate_limited: "Muitas gerações seguidas. Aguarde cerca de 1 minuto e tente de novo.",
  budget_exceeded: "Você usou todo o limite de IA do mês no seu plano. Mude de plano ou fale com o suporte para gerar o perfil.",
  ai_unavailable: "A IA está indisponível ou sobrecarregada agora. Seus dados foram mantidos; tente de novo em instantes.",
  generation_failed: "Não conseguimos montar o perfil desta vez. Seus dados foram mantidos; tente de novo. Se continuar, resuma o texto da empresa.",
  forbidden: "Você não tem permissão para gerar o perfil de agentes. Fale com um administrador.",
  timeout: "A geração demorou mais que o esperado e foi interrompida. Seus dados foram mantidos; tente de novo.",
  unavailable: "Não conseguimos falar com o servidor. Seus dados foram mantidos; tente de novo em instantes.",
};

export function failure(code: GenerateErrorCode, extra: Partial<GenerateFailure> = {}): GenerateFailure {
  return { code, message: MESSAGES[code], retryable: code !== "budget_exceeded" && code !== "forbidden" && code !== "invalid_input", ...extra };
}

function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 3600 ? Math.ceil(seconds) : undefined;
}

function fieldErrorsFrom(value: unknown): GeneratorFieldErrors {
  const out: GeneratorFieldErrors = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, message] of Object.entries(value)) {
    if (isGeneratorField(key) && typeof message === "string" && message) out[key] = message;
  }
  return out;
}

/**
 * Resposta de erro da API (`{ error: { code, message, fields? } }`) → o que a tela mostra.
 * A mensagem do servidor só é mantida onde ela é específica (validação e permissão); o resto usa texto fixo da tela.
 */
export function mapGenerateFailure(status: number, body: unknown, retryAfterHeader?: string | null): GenerateFailure {
  const error = typeof body === "object" && body !== null && "error" in body ? (body as { error: unknown }).error : null;
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof record.code === "string" ? record.code : "";
  const serverMessage = typeof record.message === "string" && record.message ? record.message : null;

  if (status === 401) return failure("forbidden", { message: "Sua sessão expirou. Entre de novo para continuar.", retryable: false, gate: "login" });
  if (status === 403) {
    if (code === "account_suspended") return failure("forbidden", { message: "Sua conta está suspensa. Regularize a assinatura para voltar a usar a IA.", gate: "suspended" });
    if (code === "two_factor_required") return failure("forbidden", { message: "Ative a verificação em duas etapas para continuar.", gate: "two_factor" });
    return failure("forbidden", serverMessage ? { message: serverMessage } : {});
  }
  if (status === 422 || code === "invalid_input") {
    const fields = fieldErrorsFrom(record.fields);
    return failure("invalid_input", { ...(serverMessage ? { message: serverMessage } : {}), ...(Object.keys(fields).length ? { fields } : {}) });
  }
  if (status === 429 || code === "rate_limited") return failure("rate_limited", { retryAfterSeconds: parseRetryAfter(retryAfterHeader) ?? 60 });
  if (status === 402 || code === "budget_exceeded") return failure("budget_exceeded");
  if (code === "ai_unavailable" || status === 503) return failure("ai_unavailable");
  if (code === "generation_failed" || status === 502) return failure("generation_failed");
  return failure("unavailable");
}
