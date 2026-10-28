import type { GenerateRequest, GenerateResult, LLMProvider } from "../llm";
import { keywords } from "./knowledge";
import { normalize } from "./text";

/**
 * "LLM" determinístico por regras, para o Simulador funcionar SEM chave (LLM_PROVIDER=fake) e para os evals.
 * Não é inteligência: roteia por palavras-chave e responde com a linha do conhecimento que mais combina.
 * Usa só o contrato `LLMProvider`; o pipeline não sabe que é fake.
 */

const base = (request: GenerateRequest): Omit<GenerateResult, "text" | "toolCalls" | "stopReason"> => ({
  usage: { inputTokens: 0, outputTokens: 0 },
  model: `demo-${request.tier}`,
  provider: "fake",
});

function lastCustomerText(request: GenerateRequest) {
  const first = request.messages[0];
  const content = typeof first?.content === "string" ? first.content : "";
  const lines = [...content.matchAll(/^\[cliente\]: (.*)$/gm)];
  return lines[lines.length - 1]?.[1] ?? "";
}

function previousAgentText(request: GenerateRequest) {
  const first = request.messages[0];
  const content = typeof first?.content === "string" ? first.content : "";
  const lines = [...content.matchAll(/^\[agente\]: (.*)$/gm)];
  return lines[lines.length - 1]?.[1] ?? "";
}

/** Id do tipo de atendimento liberado: os fictícios do simulador (`apt_…`) ou um UUID de verdade (conversas reais). */
/** Faixa de hora que o cliente pediu ("8h30", "14h", "tarde", "manhã"); nada quando não disse. */
function hourRange(text: string): { from_time?: string; to_time?: string } {
  if (/(8h30|08h30|8:30)/.test(text)) return { from_time: "08:30", to_time: "08:30" };
  if (/(14h|14:00|as 14)/.test(text)) return { from_time: "14:00", to_time: "14:00" };
  if (/tarde/.test(text)) return { from_time: "12:00", to_time: "23:59" };
  if (/manha/.test(text)) return { from_time: "00:00", to_time: "11:59" };
  return {};
}

function typeIdFrom(request: GenerateRequest) {
  const found = /apt_[a-z]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(JSON.stringify(request.tools));
  return found?.[0] ?? "apt_avaliacao";
}

function classify(text: string): { intent: string; confidence: number } {
  const t = normalize(text);
  if (/^\d{1,2}\s?(h|:\d{2})/.test(t) || /\d{1,2}h(\d{2})?/.test(t)) return { intent: "schedule", confidence: 0.9 };
  if (!/[a-z]{2}/.test(t)) return { intent: "question", confidence: 0.2 };
  if (/(horario|marcar|agendar|agenda|consulta|remarcar|sexta|segunda|terca|quarta|quinta|sabado|amanha|semana)/.test(t)) return { intent: "schedule", confidence: 0.9 };
  if (/(preco|quanto custa|valor|custa|comprar|contratar|orcamento)/.test(t)) return { intent: "buy", confidence: 0.9 };
  if (/(reclama|absurdo|pessimo|urgente)/.test(t)) return { intent: "complaint", confidence: 0.9 };
  if (/(atendente|humano|pessoa)/.test(t)) return { intent: "human", confidence: 0.9 };
  return { intent: "question", confidence: 0.85 };
}

function knowledgeLines(request: GenerateRequest) {
  const system = request.system.slice(request.system.indexOf("<conhecimento>"));
  const first = request.messages[0];
  const data = typeof first?.content === "string" ? first.content : "";
  const retrieved = [...data.matchAll(/^- \([^)]*\) (.*)$/gm)].map((m) => m[1] ?? "");
  const lines = system
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("<") && !/^(Produtos e serviços|Perguntas frequentes):$/.test(l));
  return [...retrieved, ...lines];
}

export function createDemoLlm(): LLMProvider {
  return {
    name: "fake",
    async generate(request) {
      const purpose = request.meta?.purpose ?? "";
      const common = base(request);

      if (purpose === "agent_router") {
        const c = classify(lastCustomerText(request));
        return { ...common, text: JSON.stringify(c), toolCalls: [], stopReason: "end" };
      }

      const text = normalize(lastCustomerText(request));
      const toolNames = new Set((request.tools ?? []).map((t) => t.name));
      const last = request.messages[request.messages.length - 1];

      // segunda volta: já temos resultado de ferramenta
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.some((p) => p.type === "tool_result")) {
        const outputs = last.content.flatMap((p) => (p.type === "tool_result" ? [p.output] : []));
        const slotIds = outputs.flatMap((o) => [...o.matchAll(/slot_id=(\S+) \| (.+)/g)].map((m) => ({ id: m[1] ?? "", at: m[2] ?? "" })));
        if (slotIds.length) {
          const pickLate = /(14h|14:00|as 14|segundo|tarde)/.test(text);
          const pickEarly = /(8h30|08h30|8:30|primeiro|manha)/.test(text);
          const chosen = pickLate ? slotIds.find((s) => s.at.includes("14:00")) : pickEarly ? slotIds.find((s) => s.at.includes("08:30")) : undefined;
          const typeId = typeIdFrom(request);
          if (chosen && toolNames.has("book_appointment") && /slot:/.test(chosen.id)) {
            return {
              ...common,
              text: "",
              toolCalls: [{ id: "demo_book", name: "book_appointment", input: { slot_id: chosen.id, type_id: typeId } }],
              stopReason: "tool_use",
            };
          }
          const a = slotIds[0];
          const b = slotIds.find((s) => s.at.includes("14:00"));
          return {
            ...common,
            text: `Tenho 08h30${b ? " ou 14h" : ""} disponível${a ? "" : ""}. Qual prefere?`,
            toolCalls: [],
            stopReason: "end",
          };
        }
        // a agenda recusou marcar sem o nome do cliente: o agente de demonstração pergunta (como o real faria)
        if (outputs.some((o) => o.includes("nome do cliente"))) {
          return { ...common, text: "Antes de marcar, pode me dizer seu nome completo?", toolCalls: [], stopReason: "end" };
        }
        if (outputs.some((o) => o.includes("Agendamento") || o.includes("book_appointment"))) {
          return { ...common, text: "Pronto! Deixei pré-agendado e a equipe confirma em seguida por aqui.", toolCalls: [], stopReason: "end" };
        }
        if (outputs.some((o) => o.includes("Conversa enviada"))) {
          return { ...common, text: "", toolCalls: [], stopReason: "end" };
        }
        const hit = outputs.map((o) => o.split("\n").find((l) => /^\d+\. /.test(l))).find(Boolean);
        if (hit) return { ...common, text: hit.replace(/^\d+\. /, ""), toolCalls: [], stopReason: "end" };
        return { ...common, text: "", toolCalls: [{ id: "demo_h", name: "request_human", input: { reason: "Pergunta fora do conhecimento" } }], stopReason: "tool_use" };
      }

      // primeira volta
      if (/^(oi|ola|bom dia|boa tarde|boa noite)\b/.test(text)) {
        return { ...common, text: "Oi! Como posso ajudar?", toolCalls: [], stopReason: "end" };
      }
      if (/(horario|marcar|agendar|agenda|consulta|sexta|segunda|amanha|semana|8h30|14h|primeiro|segundo)/.test(text) && toolNames.has("list_available_slots")) {
        const typeId = typeIdFrom(request);
        const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
        return {
          ...common,
          text: "",
          // como o agente real: se o cliente disse uma hora ou período, consulta já com a faixa de hora
          toolCalls: [{ id: "demo_slots", name: "list_available_slots", input: { type_id: typeId, from_date: day(0), to_date: day(7), ...hourRange(text) } }],
          stopReason: "tool_use",
        };
      }
      if (/(horario|marcar|agendar)/.test(text) && !toolNames.has("list_available_slots")) {
        return { ...common, text: "", toolCalls: [{ id: "demo_h", name: "request_human", input: { reason: "Agendamento feito pela equipe" } }], stopReason: "tool_use" };
      }
      const words = keywords(text);
      const best = knowledgeLines(request)
        .map((line) => ({ line, score: words.filter((w) => normalize(line).includes(w.slice(0, 5))).length }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score > 0) return { ...common, text: best.line.slice(0, 500), toolCalls: [], stopReason: "end" };
      return { ...common, text: "", toolCalls: [{ id: "demo_h", name: "request_human", input: { reason: "Pergunta fora do conhecimento" } }], stopReason: "tool_use" };
    },
  };
}
