// Eval de COMPREENSÃO do agente contra o provedor REAL (gasta centavos): frases informais de clientes passam pelo mesmo
// pipeline de produção (roteador + especialista + guardrails) com a configuração do agente que você passar.
// Mede quantas viram resposta e quantas viram transferência, para ajustar prompt/regras com número na mão.
//
//   CONFIG=<arquivo.json com a config do agente> REPORT=<saida.json> pnpm --filter @duckzap/api eval:comprehension
//
// Esperado por frase: "answer" = a IA deve atender (transferir é erro); "handoff" = deve chamar a equipe;
// "either" = qualquer um serve (só registra). Nunca imprime chaves.
import { createLlm, llmEnvSchema, type AgentRuntimeConfig } from "@duckzap/ai";
import { readFileSync, writeFileSync } from "node:fs";
import { runScenario } from "../../../packages/ai/evals/harness";

type Expect = "answer" | "handoff" | "either";
type Turn = { role: "customer" | "agent" | "human"; text: string };
// `before`: conversa que já existia antes da frase (a IA enxerga o histórico inteiro, e foi aí que ela se confundiu)
const CASES: { text: string; expect: Expect; before?: Turn[] }[] = [
  // cumprimentos e conversa social
  { text: "ola boa tarde", expect: "answer" },
  { text: "oi", expect: "answer" },
  { text: "bom dia, tudo bem?", expect: "answer" },
  { text: "teste", expect: "answer" },
  { text: "blz obrigado", expect: "answer" },
  { text: "opa bão", expect: "answer" },
  { text: "e aí", expect: "answer" },
  { text: "salve", expect: "answer" },
  { text: "fala", expect: "answer" },
  // pedido antigo já tratado por uma pessoa + cumprimento novo: não é pedido de pessoa
  {
    text: "opa bão",
    expect: "answer",
    before: [
      { role: "customer", text: "no caso queria saber sobre o atendimento, consegue me transferir ou agendar?" },
      { role: "human", text: "Oi! Já vou verificar isso pra você." },
    ],
  },
  {
    text: "bom dia",
    expect: "answer",
    before: [
      { role: "customer", text: "quero falar com um atendente" },
      { role: "human", text: "Oi, aqui é o Vinícius, pode falar." },
      { role: "customer", text: "era só isso, obrigado" },
    ],
  },
  // perguntas SOBRE o atendimento/transferência/agendamento (a empresa vende isso): é dúvida de produto, não pedido de pessoa
  { text: "no caso queria saber sobre o atendimento, consegue me transferir ou agendar?", expect: "answer" },
  { text: "o atendimento de vocês transfere pra um humano quando precisa?", expect: "answer" },
  { text: "como funciona o agendamento automático?", expect: "answer" },
  { text: "dá pra agendar horário pelo whatsapp com o robô de vocês?", expect: "answer" },
  // o que a empresa faz (linguagem informal e erros de digitação)
  { text: "Fala mano, tem site pra vender", expect: "answer" },
  { text: "vcs fazem site?", expect: "answer" },
  { text: "queria saber dos produtos", expect: "answer" },
  { text: "oq vcs vendem", expect: "answer" },
  { text: "no caso qeurias aber dos produtps", expect: "answer" },
  { text: "voces fazem chatbot pro whatsapp?", expect: "answer" },
  { text: "fazem automacao com IA?", expect: "answer" },
  { text: "preciso de um sistema pra minha loja", expect: "answer" },
  { text: "to precisando de um app pra minha empresa", expect: "answer" },
  { text: "meu computador ta muito lento, vcs arrumam?", expect: "answer" },
  { text: "minha impressora nao imprime, voces ajudam", expect: "answer" },
  { text: "como funciona o suporte tecnico de voces", expect: "answer" },
  { text: "vcs integram com o meu sistema atual?", expect: "answer" },
  { text: "tem loja virtual pra vender meus produtos?", expect: "answer" },
  { text: "quero automatizar meu atendimento", expect: "answer" },
  { text: "me explica como funciona", expect: "answer" },
  { text: "trabalham com que?", expect: "answer" },
  // dados que o agente pode não ter: aceitável responder "sob orçamento" ou chamar a equipe
  { text: "quanto custa um site?", expect: "either" },
  { text: "qual o horario de atendimento", expect: "either" },
  { text: "vcs atendem em sao paulo?", expect: "either" },
  { text: "quero um orçamento", expect: "either" },
  { text: "qual o prazo pra ficar pronto um site", expect: "either" },
  // deve ir para pessoa
  { text: "quero falar com um atendente", expect: "handoff" },
  { text: "to muito insatisfeito, serviço horrível", expect: "handoff" },
  { text: "meu sistema caiu e é urgente!!", expect: "handoff" },
  { text: "me passa pro gerente", expect: "handoff" },
  { text: "quero falar com o dono da empresa", expect: "handoff" },
  { text: "pode chamar alguém pra falar comigo por favor", expect: "handoff" },
];

const configPath = process.env.CONFIG;
if (!configPath) throw new Error("Defina CONFIG=<arquivo.json com a configuração do agente>.");
const config = JSON.parse(readFileSync(configPath, "utf8")) as AgentRuntimeConfig;
const llm = createLlm(llmEnvSchema.parse(process.env));

type Row = { idx: number; text: string; expect: Expect; outcome: "answered" | "handoff"; handoff: string | null; reply: string; ok: boolean };

async function run(c: (typeof CASES)[number]): Promise<Row> {
  const { result } = await runScenario(
    { id: "c", description: "c", history: [...(c.before ?? []), { role: "customer", text: c.text }], config, router: { intent: "question", confidence: 0.9 }, model: undefined, expect: {} },
    llm,
  );
  const handoff = result.handoff?.kind ?? null;
  const outcome = handoff ? "handoff" : "answered";
  const ok = c.expect === "either" ? true : c.expect === "answer" ? outcome === "answered" : outcome === "handoff";
  return { idx: CASES.indexOf(c), text: c.before ? `${c.text}  (após conversa anterior)` : c.text, expect: c.expect, outcome, handoff, reply: result.messages.join(" ").slice(0, 220), ok };
}

const rows: Row[] = [];
const queue = [...CASES];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) rows.push(await run(c));
  }),
);
rows.sort((a, b) => a.idx - b.idx);

for (const r of rows) {
  const tag = r.ok ? "OK    " : "FALHOU";
  console.log(`${tag} [${r.expect.padEnd(7)}] ${r.outcome === "handoff" ? `TRANSFERIU (${r.handoff})` : "respondeu    "} | ${r.text}${r.outcome === "answered" ? `\n          ↳ ${r.reply}` : ""}`);
}
const answerSet = rows.filter((r) => r.expect === "answer");
const handoffSet = rows.filter((r) => r.expect === "handoff");
const eitherSet = rows.filter((r) => r.expect === "either");
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "-");
console.log("\nRESUMO");
console.log(`- Devia atender: ${answerSet.filter((r) => r.ok).length}/${answerSet.length} atendidas (${pct(answerSet.filter((r) => r.ok).length, answerSet.length)})`);
console.log(`- Devia transferir: ${handoffSet.filter((r) => r.ok).length}/${handoffSet.length} transferidas`);
console.log(`- Tanto faz: ${eitherSet.filter((r) => r.outcome === "answered").length}/${eitherSet.length} atendidas pela IA`);
if (process.env.REPORT) writeFileSync(process.env.REPORT, JSON.stringify(rows, null, 2));
