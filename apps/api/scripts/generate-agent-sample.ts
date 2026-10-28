// Verificação MANUAL do gerador de perfil do agente contra o provedor REAL (gasta centavos; não rode em testes automáticos).
//
//   BASE=<config.json existente> OUT=<saida.json> [FIELDS=<fields.json>] [PURPOSE=reception] [AGENT_NAME=Jacan] \
//     pnpm --filter @duckzap/api generate:sample
//
// - BASE: configuração completa de um agente (ex.: a usada no eval:comprehension). Os campos `profile.companySummary`,
//   `knowledge.productsAndServices` e `knowledge.faq` dela viram o `companyText` (texto colado) do gerador.
// - FIELDS (opcional): JSON com os campos estruturados (sells, doesNotSell, hours…), como o formulário mandaria.
// - OUT: recebe a configuração COMPLETA (BASE com o conteúdo gerado no lugar do escrito à mão), pronta para
//   `CONFIG=<OUT> pnpm --filter @duckzap/api eval:comprehension`. `<OUT>.raw.json` guarda a saída do gerador.
// Nunca imprime chaves.
import { createLlm, generateAgentProfile, llmEnvSchema, parseGeneratorOutput, type UsageEvent } from "@duckzap/ai";
import { readFileSync, writeFileSync } from "node:fs";

const basePath = process.env.BASE;
const outPath = process.env.OUT;
if (!basePath || !outPath) throw new Error("Defina BASE=<config.json> e OUT=<saida.json>.");

type Cfg = {
  name: string;
  profile: { description: string; tone: "friendly" | "formal" | "direct"; companySummary: string };
  knowledge: { productsAndServices: string; faq: string; companyInfo?: string; examples?: { customer: string; agent: string }[] };
  advanced: { prompt: string; tools: string[]; restrictions?: string };
  [key: string]: unknown;
};
const base = JSON.parse(readFileSync(basePath, "utf8")) as Cfg;
const fields = process.env.FIELDS ? (JSON.parse(readFileSync(process.env.FIELDS, "utf8")) as Record<string, string>) : {};
const purpose = (process.env.PURPOSE ?? "reception") as "reception" | "sales" | "support" | "scheduling";

const companyText = [base.profile.companySummary, base.knowledge.productsAndServices, base.knowledge.faq].filter(Boolean).join("\n\n");
const baseLlm = createLlm(llmEnvSchema.parse(process.env));
// DEBUG_PARSE=1: mostra, para cada resposta do modelo, se passou na validação e por que não (ajuda a achar causa de nova tentativa)
const llm: typeof baseLlm = process.env.DEBUG_PARSE
  ? {
      ...baseLlm,
      name: baseLlm.name,
      async generate(request) {
        const result = await baseLlm.generate(request);
        const parsed = parseGeneratorOutput(result.text);
        console.log(`[debug] resposta: ${result.text.length} caracteres · fim: ${result.stopReason} · saída ${result.usage.outputTokens} tokens · ${parsed.ok ? "válida" : `INVÁLIDA: ${parsed.problems.join("; ")}`}`);
        return result;
      },
    }
  : baseLlm;
console.log(`Provedor: ${llm.name} · finalidade: ${purpose} · texto da empresa: ${companyText.length} caracteres`);

const events: UsageEvent[] = [];
const started = Date.now();
const { profile, usage } = await generateAgentProfile({
  llm,
  organizationId: "sample",
  signal: AbortSignal.timeout(270_000),
  onUsage: (e) => void events.push(e),
  input: { purpose, agentName: process.env.AGENT_NAME ?? base.name, tone: base.profile.tone, companyText, ...fields },
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\nOK em ${seconds}s · ${events.length} chamada(s) · modelo ${events[0]?.model ?? "?"} · tokens entrada/saída ${usage.inputTokens}/${usage.outputTokens}`);
console.log(`\nDESCRIÇÃO (${profile.description.length}): ${profile.description}`);
console.log(`\nRESUMO DA EMPRESA (${profile.companySummary.length}):\n${profile.companySummary}`);
console.log(`\nINSTRUÇÕES (${profile.instructions.length}):\n${profile.instructions}`);
console.log(`\nINFORMAÇÕES DA EMPRESA (${profile.companyInfo.length}):\n${profile.companyInfo}`);
console.log(`\nRESTRIÇÕES (${profile.restrictions.length}):\n${profile.restrictions}`);
if (profile.productsAndServices || profile.faq) console.log(`\n(legado) produtos: ${profile.productsAndServices.length} caracteres · faq: ${profile.faq.length} caracteres`);
console.log(`\nEXEMPLOS (${profile.examples.length}):`);
profile.examples.forEach((e, i) => console.log(`${i + 1}. Cliente: ${e.customer}\n   Agente:  ${e.agent}`));
console.log(`\nAVISOS (${profile.warnings.length}):`);
for (const w of profile.warnings) console.log(`- ${w}`);
console.log(`
FALTANTES ESTRUTURADOS (missingFields): ${(profile.missingFields ?? []).join(", ") || "(nenhum)"}`);

const generated: Cfg = {
  ...base,
  profile: { ...base.profile, description: profile.description, companySummary: profile.companySummary },
  // formato novo do editor: 3 textos (informações da empresa, objetivos e instruções, restrições); produtos/FAQ legados saem
  knowledge: { productsAndServices: profile.productsAndServices, faq: profile.faq, companyInfo: profile.companyInfo, examples: profile.examples },
  advanced: { ...base.advanced, prompt: profile.instructions, restrictions: profile.restrictions },
};
writeFileSync(outPath, JSON.stringify(generated, null, 2));
writeFileSync(`${outPath}.raw.json`, JSON.stringify({ profile, usage, events }, null, 2));
console.log(`\nConfig completa gravada em ${outPath}`);
