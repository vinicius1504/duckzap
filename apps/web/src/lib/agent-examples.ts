import { MAX_AGENT_EXAMPLES, MAX_EXAMPLE_CHARS, type AgentExample } from "@duckzap/contracts/agents";

// Operações da lista de exemplos de resposta (editor do agente e tela de revisão do gerador). Funções puras e imutáveis.

export { MAX_AGENT_EXAMPLES, MAX_EXAMPLE_CHARS };

export type ExampleSide = keyof AgentExample;

export function canAddExample(list: readonly AgentExample[]): boolean {
  return list.length < MAX_AGENT_EXAMPLES;
}

/** Acrescenta um par em branco no fim. No limite, devolve a lista como está. */
export function addExample(list: readonly AgentExample[], example: AgentExample = { customer: "", agent: "" }): AgentExample[] {
  if (!canAddExample(list)) return [...list];
  return [...list, { customer: clamp(example.customer), agent: clamp(example.agent) }];
}

export function removeExample(list: readonly AgentExample[], index: number): AgentExample[] {
  return list.filter((_, i) => i !== index);
}

/** Sobe (`-1`) ou desce (`1`) um par. Nas pontas não faz nada. */
export function moveExample(list: readonly AgentExample[], index: number, direction: -1 | 1): AgentExample[] {
  const target = index + direction;
  const item = list[index];
  const other = list[target];
  if (item === undefined || other === undefined) return [...list];
  const next = [...list];
  next[index] = other;
  next[target] = item;
  return next;
}

/** Troca o texto de um lado do par, respeitando o limite de caracteres. */
export function updateExample(list: readonly AgentExample[], index: number, side: ExampleSide, value: string): AgentExample[] {
  return list.map((example, i) => (i === index ? { ...example, [side]: clamp(value) } : example));
}

function clamp(value: string): string {
  return value.length > MAX_EXAMPLE_CHARS ? value.slice(0, MAX_EXAMPLE_CHARS) : value;
}

const isBlank = (example: AgentExample) => !example.customer.trim() && !example.agent.trim();

/** Pares com só um dos lados preenchido: o contrato exige os dois. */
export function incompleteExamples(list: readonly AgentExample[]): { index: number; side: ExampleSide }[] {
  const problems: { index: number; side: ExampleSide }[] = [];
  list.forEach((example, index) => {
    if (isBlank(example)) return;
    if (!example.customer.trim()) problems.push({ index, side: "customer" });
    if (!example.agent.trim()) problems.push({ index, side: "agent" });
  });
  return problems;
}

/** Remove os pares totalmente em branco e apara o texto: é o que vai para a configuração salva. */
export function cleanExamples(list: readonly AgentExample[]): AgentExample[] {
  return list
    .filter((example) => !isBlank(example))
    .map((example) => ({ customer: example.customer.trim(), agent: example.agent.trim() }))
    .slice(0, MAX_AGENT_EXAMPLES);
}

/** Texto de ajuda do contador: "3 de 12 exemplos". */
export function examplesCountLabel(count: number): string {
  return `${count} de ${MAX_AGENT_EXAMPLES} exemplos`;
}
