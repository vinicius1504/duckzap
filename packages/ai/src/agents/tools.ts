import { z } from "zod";
import type { LlmTool } from "../llm";
import { formatPrice, rankProducts, type Confidence } from "./catalog";
import { formatLocal, hasRealName, localMinutes, parseClock, spreadSlots } from "./local-time";
import { isWithinBusinessHours, nextBusinessTime } from "./text";
import {
  MAX_PHOTO_PRODUCTS_PER_TURN,
  PortError,
  type AgentPorts,
  type AgentRuntimeConfig,
  type BusinessHours,
  type KnowledgeHit,
  type ProductInfo,
  type Scope,
  type ToolName,
} from "./types";

/**
 * Tools (§4.2): pequenas, tipadas com Zod e ESCOPADAS pelo servidor. O modelo nunca informa organization_id,
 * contact_id nem conversation_id: o `scope` vem do `ToolContext`. Campos extras que o modelo mandar são descartados.
 * Em `dryRun` (simulador/copiloto) as leituras rodam, as ESCRITAS não: devolvem "(teste) … nada foi gravado".
 */

export type ToolContext = {
  scope: Scope;
  config: AgentRuntimeConfig;
  ports: AgentPorts;
  dryRun: boolean;
  now: Date;
  /** Fuso da empresa: horários que a ferramenta devolve ao modelo saem nele (nunca em UTC). */
  timeZone?: string;
  businessHours?: BusinessHours;
  allowedTags: string[];
  /** Preenchido pelo pipeline com tudo que search_knowledge devolver (alimenta o guardrail de preço). */
  onKnowledge?: (hits: KnowledgeHit[]) => void;
  /**
   * `send_product_photos` registra aqui o produto cujas fotos devem ir na conversa (quem envia é o chamador do turno):
   * `added` entrou; `duplicate` já estava pedido; `limit` já há `MAX_PHOTO_PRODUCTS_PER_TURN` produtos neste turno.
   */
  requestPhotos?: (productId: string) => "added" | "duplicate" | "limit";
};

export type ToolOutcome = {
  ok: boolean;
  output: string;
  /** null quando o modelo chamou uma ferramenta que não existe/não está liberada */
  trace: { tool: ToolName; args: Record<string, string>; result: string; ok: boolean } | null;
  handoffReason?: string;
};

type ToolDef = {
  name: ToolName;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  /** escreve dados? (dry-run não executa) */
  write: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<{ output: string; handoffReason?: string }>;
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD.");
const ALLOWED_FIELDS = ["name", "email"] as const;

function enumOf(values: string[]) {
  const [first, ...rest] = values;
  const tuple: [string, ...string[]] = [first ?? "_", ...rest];
  return z.enum(tuple);
}

/** Tools que o agente pode usar nesta configuração (request_human é sempre ligada, §4.2). */
export function enabledToolNames(config: AgentRuntimeConfig): Set<ToolName> {
  const enabled = new Set<ToolName>(["request_human"]);
  const set = new Set(config.advanced.tools);
  if (set.has("search_knowledge")) enabled.add("search_knowledge");
  if (config.scheduling.canBook && config.scheduling.appointmentTypeIds.length > 0) {
    if (set.has("list_available_slots")) enabled.add("list_available_slots");
    if (set.has("book_appointment")) enabled.add("book_appointment");
    if (set.has("reschedule_appointment")) {
      enabled.add("reschedule_appointment");
      enabled.add("cancel_appointment");
    }
  }
  if (set.has("update_contact_fields")) enabled.add("update_contact_fields");
  if (set.has("add_tag")) enabled.add("add_tag");
  if (set.has("schedule_followup") && config.followUp.enabled && config.followUp.steps.length > 0) enabled.add("schedule_followup");
  // catálogo é função do sistema (como a agenda): vale `config.catalog`, que o runtime preenche pela empresa; `advanced.tools` não entra
  if (config.catalog?.enabled) {
    enabled.add("search_products");
    enabled.add("send_product_photos");
    enabled.add("register_interest");
  }
  return enabled;
}

const CONFIDENCE_LABEL: Record<Confidence, string> = { high: "ALTA", medium: "MÉDIA", low: "BAIXA" };

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const priceLabel = (cents: number | null) => (cents === null ? "valor sob consulta" : formatPrice(cents));

/** Texto do produto que entra no corpus do guardrail de preço: só valor que está AQUI pode ser citado ao cliente. */
function catalogFact(p: ProductInfo) {
  return oneLine(`${p.name}. ${priceLabel(p.priceCents)}. ${p.description}`);
}

/** Motivo curto para a equipe ("Interesse de compra: …"), limitado ao teto do `request_human`. */
export function interestReason(summary: string) {
  return `Interesse de compra: ${oneLine(summary)}`.slice(0, 200);
}

export function buildToolDefs(ctx: ToolContext, typeNames: Map<string, string> = new Map()): ToolDef[] {
  const enabled = enabledToolNames(ctx.config);
  const typeIds = ctx.config.scheduling.appointmentTypeIds;
  const typeDoc = typeIds.map((id) => `${id} (${typeNames.get(id) ?? id})`).join(", ");
  const defs: ToolDef[] = [];

  defs.push({
    name: "search_knowledge",
    description: "Busca trechos no conhecimento do agente (documentos e textos). Use antes de responder dúvidas sobre a empresa.",
    schema: z.object({ query: z.string().trim().min(2).max(200).describe("O que procurar, em poucas palavras") }),
    write: false,
    async run(args, c) {
      const query = String(args.query);
      const hits = await c.ports.knowledge.search(c.scope, query, 4);
      c.onKnowledge?.(hits);
      if (!hits.length) return { output: "Nenhum trecho encontrado no conhecimento." };
      return { output: hits.map((h, i) => `${i + 1}. ${h.text}`).join("\n") };
    },
  });

  if (typeIds.length > 0) {
    defs.push({
      name: "list_available_slots",
      description: `Lista horários livres para um tipo de atendimento. Tipos permitidos: ${typeDoc}. Consulte SÓ a janela que o cliente pediu (até 14 dias) e use from_time/to_time (HH:MM, horário local) para a faixa de hora que ele prefere: manhã = 00:00 a 11:59, tarde = 12:00 a 23:59, "depois das 14h" = from_time 14:00, "às 10h" = 10:00 a 10:59. Devolve poucos horários; para ver outros, consulte de novo com um dia só ou outra faixa.`,
      schema: z.object({
        type_id: enumOf(typeIds),
        from_date: isoDate,
        to_date: isoDate,
        from_time: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM.").optional(),
        to_time: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM.").optional(),
      }),
      write: false,
      async run(args, c) {
        const days = (Date.parse(`${String(args.to_date)}T00:00:00Z`) - Date.parse(`${String(args.from_date)}T00:00:00Z`)) / 86_400_000;
        if (!(days >= 0)) throw new PortError("invalid", "A data final não pode ser antes da inicial.");
        if (days > 14) throw new PortError("invalid", "Consulte no máximo 14 dias de cada vez: pergunte ao cliente a semana ou o dia que ele prefere.");
        const fromMin = args.from_time === undefined ? 0 : parseClock(String(args.from_time));
        const toMin = args.to_time === undefined ? 24 * 60 - 1 : parseClock(String(args.to_time));
        if (fromMin === null || toMin === null) throw new PortError("invalid", "Hora inválida: use HH:MM entre 00:00 e 23:59.");
        if (fromMin > toMin) throw new PortError("invalid", "A hora final não pode ser antes da inicial.");
        const all = await c.ports.agenda.listAvailableSlots(c.scope, {
          typeId: String(args.type_id),
          from: String(args.from_date),
          to: String(args.to_date),
        });
        const slots = all.filter((s) => {
          const minutes = localMinutes(s.startsAt, c.timeZone);
          return minutes >= fromMin && minutes <= toMin;
        });
        if (!slots.length) {
          return { output: all.length ? "Sem horários livres nessa faixa de hora. Há horários em outras faixas do mesmo período: consulte sem o filtro de hora ou ofereça outra faixa." : "Sem horários livres nesse período." };
        }
        const shown = spreadSlots(slots, c.timeZone);
        const lines = shown.map((s) => `slot_id=${s.id} | ${formatLocal(s.startsAt, c.timeZone)}`);
        if (slots.length > shown.length) lines.push(`(${shown.length} de ${slots.length} horários livres; para ver outros, consulte um dia só ou outra faixa de hora.)`);
        return { output: lines.join("\n") };
      },
    });

    defs.push({
      name: "book_appointment",
      description: `Marca o agendamento (já fica CONFIRMADO; se o sistema não conseguir confirmar, fica pendente e a resposta avisa). Só para estes tipos: ${typeDoc}. Use um slot_id devolvido por list_available_slots.`,
      schema: z.object({ slot_id: z.string().min(1).max(120), type_id: enumOf(typeIds) }),
      write: true,
      async run(args, c) {
        const type = await c.ports.agenda.getType(c.scope, String(args.type_id));
        if (!type) throw new PortError("not_found", "Tipo de atendimento não encontrado.");
        if (type.staffOnly) throw new PortError("forbidden", `${type.name}: só a equipe marca. Chame request_human.`);
        // o cadastro nasce só com o telefone: sem nome de verdade a agenda da equipe fica com "+55 67 9…". A regra é do servidor
        // (não confia no modelo lembrar de perguntar): sem nome, recusa e diz o que fazer.
        const contact = await c.ports.contacts.getContact(c.scope);
        if (!hasRealName(contact?.name)) {
          throw new PortError("invalid", "Antes de marcar, pergunte o nome do cliente e salve com update_contact_fields. Depois marque o horário.");
        }
        const a = await c.ports.agenda.bookAppointment(c.scope, { slotId: String(args.slot_id), typeId: type.id });
        return { output: a.status === "confirmed" ? `Agendamento CONFIRMADO: ${formatLocal(a.startsAt, c.timeZone)} (${type.name}).` : `Agendamento criado como PENDENTE: ${formatLocal(a.startsAt, c.timeZone)} (${type.name}). A equipe confirma em seguida.` };
      },
    });

    defs.push({
      name: "reschedule_appointment",
      description: "Remarca um agendamento DO PRÓPRIO cliente (id listado em agendamentos_do_cliente) para um slot_id livre.",
      schema: z.object({ appointment_id: z.string().min(1).max(120), slot_id: z.string().min(1).max(120) }),
      write: true,
      async run(args, c) {
        const a = await c.ports.agenda.rescheduleAppointment(c.scope, { appointmentId: String(args.appointment_id), slotId: String(args.slot_id) });
        return { output: a.status === "confirmed" ? `Agendamento remarcado e CONFIRMADO para ${formatLocal(a.startsAt, c.timeZone)}.` : `Agendamento remarcado para ${formatLocal(a.startsAt, c.timeZone)}, PENDENTE: a equipe confirma em seguida.` };
      },
    });

    defs.push({
      name: "cancel_appointment",
      description: "Cancela um agendamento DO PRÓPRIO cliente (id listado em agendamentos_do_cliente), quando o cliente pedir.",
      schema: z.object({ appointment_id: z.string().min(1).max(120) }),
      write: true,
      async run(args, c) {
        await c.ports.agenda.cancelAppointment(c.scope, { appointmentId: String(args.appointment_id) });
        return { output: "Agendamento cancelado." };
      },
    });
  }

  defs.push({
    name: "update_contact_fields",
    description: `Atualiza dados do cliente. Campos permitidos: ${ALLOWED_FIELDS.join(", ")}.`,
    schema: z
      .object({ name: z.string().trim().min(2).max(80).optional(), email: z.email().max(120).optional() })
      .refine((v) => v.name !== undefined || v.email !== undefined, "Informe name ou email."),
    write: true,
    async run(args, c) {
      const fields: { name?: string; email?: string } = {};
      if (typeof args.name === "string") fields.name = args.name;
      if (typeof args.email === "string") fields.email = args.email;
      await c.ports.contacts.updateFields(c.scope, fields);
      return { output: `Dados atualizados: ${Object.keys(fields).join(", ")}.` };
    },
  });

  if (ctx.allowedTags.length > 0) {
    defs.push({
      name: "add_tag",
      description: `Aplica uma etiqueta (move a etapa do funil). Permitidas: ${ctx.allowedTags.join(", ")}.`,
      schema: z.object({ tag: enumOf(ctx.allowedTags) }),
      write: true,
      async run(args, c) {
        await c.ports.contacts.addTag(c.scope, String(args.tag));
        return { output: `Etiqueta "${String(args.tag)}" aplicada.` };
      },
    });
  }

  defs.push({
    name: "request_human",
    description: "Passa a conversa para a equipe. Use quando não souber, o cliente pedir uma pessoa, reclamar ou houver urgência.",
    schema: z.object({ reason: z.string().trim().min(3).max(200).describe("Motivo curto, para a equipe") }),
    write: true,
    async run(args, c) {
      const reason = String(args.reason);
      await c.ports.conversations.requestHuman(c.scope, reason);
      return { output: "Conversa enviada para a equipe.", handoffReason: reason };
    },
  });

  defs.push({
    name: "search_products",
    description:
      "Procura no catálogo de produtos da empresa o que o cliente pediu. Aceita nome parcial, erro de digitação ou descrição (\"camiseta preta\", \"aquela do vestido azul\"). Devolve até 3 candidatos com product_id, valor e CONFIANÇA. Use SEMPRE antes de falar de um produto ou do valor dele; modelos diferentes (tamanho, cor) são produtos separados.",
    schema: z.object({ query: z.string().trim().min(2).max(200).describe("O que o cliente pediu, nas palavras dele") }),
    write: false,
    async run(args, c) {
      const products = await c.ports.catalog.listAvailable(c.scope);
      const ranked = rankProducts(String(args.query), products, { limit: 3 });
      if (!ranked.length) {
        return {
          output: "Nenhum produto parecido no catálogo. Não invente nem adivinhe: diga que não encontrou, peça o nome, a cor ou o tamanho, ou ofereça chamar a equipe.",
        };
      }
      // os valores do catálogo passam a valer para o guardrail de preço (e só eles: preço inventado continua barrado)
      c.onKnowledge?.(ranked.map((r) => ({ id: r.product.id, documentName: "Catálogo", text: catalogFact(r.product), score: r.score })));
      const top = ranked[0]!;
      const several = ranked.some((r) => r.ambiguous);
      const advice = several
        ? "Há mais de um produto parecido: pergunte ao cliente QUAL deles ele quer (cite os nomes), antes de falar de valor, mandar foto ou fechar."
        : top.confidence === "high"
          ? `Correspondência de confiança ALTA: ${top.product.name}. Pode seguir com ela.`
          : `Não tenho certeza de que é este: CONFIRME com o cliente ("Você quis dizer ${top.product.name}?") antes de falar de valor, mandar foto ou fechar.`;
      const lines = ranked.map((r) => {
        const p = r.product;
        const parts = [
          `product_id=${p.id}`,
          p.name,
          priceLabel(p.priceCents),
          p.photoCount === 0 ? "sem fotos" : `${p.photoCount} foto${p.photoCount === 1 ? "" : "s"}`,
          `confiança ${CONFIDENCE_LABEL[r.confidence]}${r.ambiguous ? " (parecido com outro)" : ""}`,
        ];
        const description = oneLine(p.description).slice(0, 200);
        return description ? `${parts.join(" | ")} | ${description}` : parts.join(" | ");
      });
      return { output: `${advice}\n${lines.join("\n")}` };
    },
  });

  defs.push({
    name: "send_product_photos",
    description:
      "Manda as fotos de um produto do catálogo para o cliente (até 2 produtos por vez). Use só depois de search_products, com o product_id do produto CONFIRMADO, e quando o cliente pedir foto ou ao apresentar o produto. As fotos seguem logo depois da sua mensagem.",
    schema: z.object({ product_id: z.string().trim().min(1).max(80).describe("product_id devolvido por search_products") }),
    write: true,
    async run(args, c) {
      const product = await c.ports.catalog.getProduct(c.scope, String(args.product_id));
      if (!product) throw new PortError("not_found", "Produto não encontrado no catálogo. Use um product_id devolvido por search_products.");
      if (product.photoCount === 0) {
        return { output: `${product.name} não tem fotos cadastradas. Descreva o produto em texto e, se o cliente quiser ver, ofereça chamar a equipe.` };
      }
      const added = c.requestPhotos?.(product.id) ?? "added";
      if (added === "limit") {
        throw new PortError("invalid", `Só dá para mandar fotos de ${MAX_PHOTO_PRODUCTS_PER_TURN} produtos por vez. Mande as outras se o cliente pedir depois.`);
      }
      return {
        output:
          added === "duplicate"
            ? `As fotos de ${product.name} já vão ser enviadas.`
            : `As fotos de ${product.name} vão ser enviadas logo depois da sua mensagem. Escreva a resposta normalmente (ex.: "te mando a foto aqui") e não repita a descrição inteira.`,
      };
    },
  });

  defs.push({
    name: "register_interest",
    description:
      "O cliente quer COMPRAR. Deixa uma nota interna para a equipe com o que foi combinado e chama a equipe para fechar. Use depois de coletar o essencial (produto, quantidade, forma de pagamento, entrega ou retirada). NÃO escreva valores no resumo: o sistema anexa os produtos e os preços do catálogo.",
    schema: z.object({
      summary: z.string().trim().min(3).max(500).describe("O que o cliente quer: quantidade, pagamento, entrega/retirada e observações, sem valores"),
      product_ids: z.array(z.string().trim().min(1).max(80)).max(5).optional().describe("product_id dos produtos de interesse"),
    }),
    write: true,
    async run(args, c) {
      const summary = oneLine(String(args.summary));
      const ids = [...new Set(Array.isArray(args.product_ids) ? args.product_ids.map(String) : [])];
      const products: ProductInfo[] = [];
      for (const id of ids) {
        const p = await c.ports.catalog.getProduct(c.scope, id);
        if (p) products.push(p);
      }
      // nome e preço vêm do CATÁLOGO, nunca do texto livre do modelo
      const note = [
        "Interesse de compra (registrado pela IA)",
        ...(products.length ? ["Produtos:", ...products.map((p) => `- ${p.name} — ${priceLabel(p.priceCents)}`)] : []),
        `Combinado com o cliente: ${summary}`,
      ].join("\n");
      await c.ports.conversations.addInternalNote(c.scope, note);
      const reason = interestReason(summary);
      await c.ports.conversations.requestHuman(c.scope, reason);
      return {
        output: "Interesse registrado e conversa enviada para a equipe. Avise o cliente que uma pessoa vai continuar para confirmar o total, o pagamento e a entrega. Não cobre nem prometa prazo.",
        handoffReason: reason,
      };
    },
  });

  const steps = ctx.config.followUp.steps;
  if (steps.length > 0) {
    defs.push({
      name: "schedule_followup",
      description: `Agenda a retomada da conversa em um passo do follow-up configurado. Passos: ${steps.map((s) => s.id).join(", ")}.`,
      schema: z.object({ step_id: enumOf(steps.map((s) => s.id)) }),
      write: true,
      async run(args, c) {
        const step = steps.find((s) => s.id === args.step_id);
        if (!step) throw new PortError("invalid", "Passo de follow-up inexistente.");
        let runAt = new Date(c.now.getTime() + step.delayMinutes * 60_000);
        if (c.config.followUp.respectBusinessHours && c.businessHours && !isWithinBusinessHours(runAt, c.businessHours)) {
          runAt = nextBusinessTime(runAt, c.businessHours);
        }
        await c.ports.conversations.scheduleFollowup(c.scope, { stepId: step.id, runAt });
        return { output: `Follow-up agendado para ${runAt.toISOString()}.` };
      },
    });
  }

  return defs.filter((d) => enabled.has(d.name));
}

/** Definições no formato neutro do LLMProvider (JSON Schema a partir do Zod). */
export function toLlmTools(defs: ToolDef[]): LlmTool[] {
  return defs.map((d) => {
    const json = z.toJSONSchema(d.schema, { io: "input", unrepresentable: "any" });
    const properties = typeof json.properties === "object" && json.properties !== null ? { ...json.properties } : {};
    const required = Array.isArray(json.required) ? json.required.filter((r): r is string => typeof r === "string") : undefined;
    return { name: d.name, description: d.description, inputSchema: { type: "object", properties, ...(required?.length ? { required } : {}) } };
  });
}

function stringify(args: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  return out;
}

/** Executa uma chamada do modelo: valida com Zod, aplica dry-run e converte falhas em resultado de erro. */
export async function executeTool(defs: ToolDef[], ctx: ToolContext, name: string, rawInput: Record<string, unknown>): Promise<ToolOutcome> {
  const fail = (tool: ToolName, args: Record<string, string>, message: string): ToolOutcome => ({
    ok: false,
    output: message,
    trace: { tool, args, result: message, ok: false },
  });
  const def = defs.find((d) => d.name === name);
  if (!def) {
    return { ok: false, output: `Ferramenta "${name}" não existe ou não está liberada para este agente.`, trace: null };
  }
  const parsed = def.schema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(def.name, stringify(rawInput), `Argumentos inválidos: ${parsed.error.issues[0]?.message ?? "confira os campos"}.`);
  }
  const args = parsed.data; // só campos conhecidos (o Zod descarta extras como organization_id)
  if (def.write && ctx.dryRun) {
    const result = `(teste) ${def.name} não executada; nada foi gravado.`;
    return {
      ok: true,
      output: result,
      trace: { tool: def.name, args: stringify(args), result, ok: true },
      ...(def.name === "request_human" ? { handoffReason: String(args.reason) } : {}),
      ...(def.name === "register_interest" ? { handoffReason: interestReason(String(args.summary)) } : {}),
    };
  }
  try {
    const out = await def.run(args, ctx);
    return { ok: true, output: out.output, trace: { tool: def.name, args: stringify(args), result: out.output, ok: true }, handoffReason: out.handoffReason };
  } catch (error) {
    const message = error instanceof PortError ? error.message : "Falha ao executar a ferramenta.";
    return fail(def.name, stringify(args), message);
  }
}
