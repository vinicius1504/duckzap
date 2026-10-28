// Teste manual do provedor de IA configurado (LLM_PROVIDER/LLM_API_KEY): `pnpm --filter @duckzap/api llm:smoke`.
// Faz chamadas reais (gastam tokens). Não imprime a chave.
import { createLlm, llmEnvSchema } from "@duckzap/ai";

const llm = createLlm(llmEnvSchema.parse(process.env));
console.log(`Provedor: ${llm.name}`);

for (const tier of ["fast", "smart"] as const) {
  const started = Date.now();
  const out = await llm.generate({
    tier,
    system: "Você é um atendente simpático de uma clínica odontológica. Responda em português, em uma frase.",
    messages: [{ role: "user", content: "Vocês atendem aos sábados?" }],
    maxOutputTokens: 120,
    meta: { organizationId: "smoke", purpose: "smoke" },
  });
  console.log(`[${tier}] ${out.model} · ${Date.now() - started} ms · tokens ${out.usage.inputTokens}/${out.usage.outputTokens} · ${out.stopReason}`);
  console.log(`  → ${out.text.trim().slice(0, 200)}`);
}

const tool = await llm.generate({
  tier: "smart",
  system: "Use a ferramenta quando o cliente pedir para ver horários.",
  messages: [{ role: "user", content: "Quero ver os horários livres de sexta para uma limpeza." }],
  tools: [
    {
      name: "list_available_slots",
      description: "Lista horários livres da agenda.",
      inputSchema: {
        type: "object",
        properties: { type: { type: "string", description: "tipo de atendimento" }, weekday: { type: "string" } },
        required: ["type"],
      },
    },
  ],
  maxOutputTokens: 200,
  meta: { organizationId: "smoke", purpose: "smoke-tool" },
});
console.log(`[tool] stop=${tool.stopReason} calls=${JSON.stringify(tool.toolCalls)}`);
