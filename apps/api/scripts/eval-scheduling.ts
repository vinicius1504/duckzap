// Eval de AGENDAMENTO contra o provedor REAL (gasta centavos): um "cliente" simulado (modelo `fast`, com uma meta) conversa
// com o agente pelo mesmo pipeline de produção, com agenda em memória (nada é gravado). Mede o que importa para o dono:
// a IA marcou? pediu o nome quando faltava? disse o horário CERTO (fuso local, não UTC)? marcou só depois do cliente escolher?
//
//   CONFIG=<arquivo.json com a config do agente> REPORT=<saida.json> pnpm --filter @duckzap/api eval:scheduling
//
// Nunca imprime chaves.
import { createLlm, createInMemoryPorts, effectiveSchedulingConfig, bookableTypeIds, llmEnvSchema, runAgentTurn, type AgentRuntimeConfig, type AppointmentTypeInfo } from "@duckzap/ai";
import { readFileSync, writeFileSync } from "node:fs";

type Turn = { role: "customer" | "agent" | "human"; text: string };

const TZ = "America/Sao_Paulo";
// quarta-feira, 28/10/2026, 10:00 em São Paulo
const NOW = new Date("2026-10-28T13:00:00Z");

const ONE_TYPE: AppointmentTypeInfo[] = [{ id: "apt_reuniao", name: "Reunião de apresentação", durationMinutes: 30, staffOnly: false }];
const TWO_TYPES: AppointmentTypeInfo[] = [
  { id: "apt_reuniao", name: "Reunião de apresentação", durationMinutes: 30, staffOnly: false },
  { id: "apt_visita", name: "Visita técnica", durationMinutes: 60, staffOnly: false },
  { id: "apt_interno", name: "Auditoria interna", durationMinutes: 90, staffOnly: true },
];

type Scenario = {
  id: string;
  title: string;
  types: AppointmentTypeInfo[];
  contactName: string | null;
  /** O que o cliente quer e como se comporta (o simulador responde só o que for perguntado). */
  persona: string;
  /** primeira mensagem do cliente */
  opening: string;
  existing?: { id: string; typeId: string; startsAt: string; status: "pending" | "confirmed" }[];
  expect: { booked?: number; canceled?: number; askedName?: boolean };
};

const SCENARIOS: Scenario[] = [
  {
    id: "um-tipo-nome-conhecido",
    title: "Um tipo só, nome já cadastrado, quer amanhã de manhã",
    types: ONE_TYPE,
    contactName: "Maria Souza",
    persona: "Você é Maria. Quer marcar uma reunião de apresentação AMANHÃ DE MANHÃ. Aceita o primeiro horário que a atendente oferecer e confirma com 'pode ser'. Responda só o que for perguntado, curto, estilo WhatsApp.",
    opening: "oi, quero marcar uma reunião",
    expect: { booked: 1, askedName: false },
  },
  {
    id: "nome-desconhecido",
    title: "Nome desconhecido (cadastro só com o telefone), dois tipos",
    types: TWO_TYPES,
    contactName: "+55 67 99999-0000",
    persona: "Você é Carlos Eduardo. Quer uma VISITA TÉCNICA na sexta-feira à tarde. Se perguntarem seu nome, diga 'Carlos Eduardo'. Escolha o primeiro horário oferecido e confirme. Responda só o que for perguntado, curto, estilo WhatsApp.",
    opening: "queria agendar uma visita aí",
    expect: { booked: 1, askedName: true },
  },
  {
    id: "vago",
    title: "Pedido vago: 'quero agendar'",
    types: TWO_TYPES,
    contactName: "Ana Lima",
    persona: "Você é Ana. Quer uma REUNIÃO DE APRESENTAÇÃO na quinta-feira, de preferência depois das 14h. Só diga isso quando perguntarem. Aceite o horário que servir e confirme. Responda só o que for perguntado, curto, estilo WhatsApp.",
    opening: "quero agendar",
    expect: { booked: 1, askedName: false },
  },
  {
    id: "mes-que-vem",
    title: "Só diz o mês ('mês que vem'): a IA deve perguntar a semana, não consultar o mês inteiro",
    types: ONE_TYPE,
    contactName: "Bruno Alves",
    persona: "Você é Bruno. Quer marcar uma reunião de apresentação 'no mês que vem' (novembro), sem dia certo. Só se perguntarem a semana, diga 'na segunda semana, de preferência à tarde'. Aceite o primeiro horário que a atendente oferecer e confirme. Responda só o que for perguntado, curto, estilo WhatsApp.",
    opening: "queria marcar uma reunião pro mês que vem",
    expect: { booked: 1 },
  },
  {
    id: "cancelar",
    title: "Cancelar um agendamento existente",
    types: ONE_TYPE,
    contactName: "Paulo Ramos",
    existing: [{ id: "apt_ex1", typeId: "apt_reuniao", startsAt: "2026-10-30T17:00:00Z", status: "pending" }],
    persona: "Você é Paulo. Tem uma reunião marcada e quer CANCELAR, não quer remarcar. Confirme o cancelamento se perguntarem. Responda só o que for perguntado, curto, estilo WhatsApp.",
    opening: "preciso cancelar minha reunião",
    expect: { canceled: 1, booked: 0 },
  },
  {
    id: "remarcar",
    title: "Remarcar para outro dia",
    types: ONE_TYPE,
    contactName: "Paulo Ramos",
    existing: [{ id: "apt_ex1", typeId: "apt_reuniao", startsAt: "2026-10-30T17:00:00Z", status: "pending" }],
    persona: "Você é Paulo. Tem uma reunião marcada para sexta e quer REMARCAR para a SEGUNDA-FEIRA da semana que vem, de manhã. Aceite o primeiro horário que servir e confirme. Responda só o que for perguntado, curto, estilo WhatsApp.",
    opening: "queria remarcar minha reunião",
    expect: { booked: 0, canceled: 0 },
  },
];

const configPath = process.env.CONFIG;
if (!configPath) throw new Error("Defina CONFIG=<arquivo.json com a configuração do agente>.");
const base = JSON.parse(readFileSync(configPath, "utf8")) as AgentRuntimeConfig;
const llm = createLlm(llmEnvSchema.parse(process.env));

async function nextCustomerLine(persona: string, transcript: Turn[]): Promise<string> {
  const lines = transcript.map((t) => `${t.role === "customer" ? "VOCÊ" : "ATENDENTE"}: ${t.text}`).join("\n");
  const out = await llm.generate({
    tier: "fast",
    system: `Você simula um CLIENTE brasileiro conversando por WhatsApp com a atendente de uma empresa. ${persona} Responda com UMA mensagem curta do cliente, sem aspas e sem explicações. Se a atendente já confirmou o que você queria, responda "valeu, obrigado".`,
    messages: [{ role: "user", content: `Conversa até agora:\n${lines}\n\nEscreva a próxima mensagem do cliente.` }],
    maxOutputTokens: 400,
    meta: { organizationId: "org_eval", conversationId: "conv_eval", purpose: "agent_simulator" },
  });
  return out.text.trim().replace(/^"|"$/g, "") || "ok";
}

type Result = {
  id: string;
  title: string;
  turns: number;
  booked: number;
  canceled: number;
  rescheduled: number;
  askedName: boolean;
  bookedBeforeChoice: boolean;
  wrongHours: string[];
  listErrors: number;
  handoff: string | null;
  transcript: Turn[];
  toolSequence: string[];
  ok: boolean;
  problems: string[];
};

async function run(sc: Scenario): Promise<Result> {
  const ids = bookableTypeIds(sc.types.map((t) => ({ id: t.id, staffOnly: t.staffOnly })));
  const config = effectiveSchedulingConfig(base, ids);
  const { ports, state } = createInMemoryPorts({
    types: sc.types,
    now: () => NOW,
    contact: { name: sc.contactName, email: null, phone: "+55 67 99999-0000", tags: [] },
    appointments: (sc.existing ?? []).map((a) => ({ ...a, contactId: "contact_eval" })),
  });
  const history: Turn[] = [];
  const toolSequence: string[] = [];
  let listErrors = 0;
  let conversationState: "ai_active" | "waiting_customer" = "ai_active";
  let handoff: string | null = null;
  let customer = sc.opening;
  const problems: string[] = [];

  for (let turn = 0; turn < 8; turn++) {
    history.push({ role: "customer", text: customer });
    const input = {
      scope: { organizationId: "org_eval", conversationId: "conv_eval", contactId: "contact_eval", agentId: "agt_eval" },
      mode: "live" as const,
      config,
      state: conversationState,
      history: [...history],
      llm,
      ports,
      now: NOW,
      nonce: "nonce_eval",
      timeZone: TZ,
    };
    const result = await runAgentTurn(input as Parameters<typeof runAgentTurn>[0]);
    for (const t of result.toolCalls ?? []) {
      toolSequence.push(t.tool);
      if (t.tool === "list_available_slots" && !t.ok) listErrors++;
    }
    conversationState = "waiting_customer";
    if (result.handoff) {
      handoff = result.handoff.kind;
      for (const m of result.messages) history.push({ role: "agent", text: m });
      break;
    }
    for (const m of result.messages) history.push({ role: "agent", text: m });
    // concluiu (marcou, remarcou ou cancelou) e já respondeu ao cliente: encerra, sem ficar trocando "valeu"
    const done = state.writes.some((w) => ["bookAppointment", "rescheduleAppointment", "cancelAppointment"].includes(w.method));
    if (done) break;
    customer = await nextCustomerLine(sc.persona, history);
  }

  const written = state.writes.map((w) => w.method);
  const booked = written.filter((m) => m === "bookAppointment").length;
  const canceled = written.filter((m) => m === "cancelAppointment").length;
  const rescheduled = written.filter((m) => m === "rescheduleAppointment").length;
  const askedName = state.writes.some((w) => w.method === "updateFields") || history.some((t) => t.role === "agent" && /nome/i.test(t.text));

  // horário errado = a IA falou um horário em UTC (11:30/17:00 no lugar de 08:30/14:00 locais)
  const agentText = history.filter((t) => t.role === "agent").map((t) => t.text).join("\n");
  const wrongHours = [...agentText.matchAll(/\b(11[:h]30|17[:h]00|11h|17h|20h|21h)\b/g)].map((m) => m[0]);

  // marcou antes de o cliente escolher? (nenhuma fala do cliente depois de a IA oferecer horários, antes do primeiro book)
  let bookedBeforeChoice = false;
  const firstBookIdx = toolSequence.indexOf("book_appointment");
  const firstSlotsIdx = toolSequence.indexOf("list_available_slots");
  if (firstBookIdx >= 0 && firstSlotsIdx >= 0 && firstBookIdx < firstSlotsIdx) bookedBeforeChoice = true;

  if (sc.expect.booked !== undefined && booked !== sc.expect.booked) problems.push(`marcou ${booked}, esperado ${sc.expect.booked}`);
  if (sc.expect.canceled !== undefined && canceled !== sc.expect.canceled) problems.push(`cancelou ${canceled}, esperado ${sc.expect.canceled}`);
  if (sc.id === "remarcar" && rescheduled + booked < 1) problems.push("não remarcou");
  if (sc.expect.askedName === true && !askedName) problems.push("não pediu o nome");
  if (sc.expect.askedName === true && firstBookIdx >= 0 && !state.writes.some((w) => w.method === "updateFields") && state.contact.name === sc.contactName) problems.push("marcou sem salvar o nome");
  if (wrongHours.length) problems.push(`falou horário em UTC: ${[...new Set(wrongHours)].join(", ")}`);
  if (bookedBeforeChoice) problems.push("marcou sem consultar os horários");
  if (listErrors) problems.push(`consulta recusada ${listErrors}x (janela grande demais ou hora inválida)`);
  if (handoff) problems.push(`transferiu (${handoff})`);

  return { id: sc.id, title: sc.title, turns: history.filter((t) => t.role === "customer").length, booked, canceled, rescheduled, askedName, bookedBeforeChoice, wrongHours, listErrors, handoff, transcript: history, toolSequence, ok: problems.length === 0, problems };
}

const only = process.env.ONLY?.split(",");
const results: Result[] = [];
for (const sc of SCENARIOS.filter((s) => !only || only.includes(s.id))) {
  const r = await run(sc);
  results.push(r);
  console.log(`\n${r.ok ? "OK    " : "FALHOU"} ${r.title}`);
  console.log(`  ferramentas: ${r.toolSequence.join(" → ") || "(nenhuma)"} | marcou ${r.booked}, remarcou ${r.rescheduled}, cancelou ${r.canceled}, turnos do cliente ${r.turns}`);
  for (const p of r.problems) console.log(`  ⚠ ${p}`);
  if (process.env.SHOW) for (const t of r.transcript) console.log(`    ${t.role === "customer" ? "CLIENTE" : "IA     "}: ${t.text.replace(/\n/g, " ⏎ ")}`);
}
console.log(`\nRESUMO: ${results.filter((r) => r.ok).length}/${results.length} cenários sem problema`);
if (process.env.REPORT) writeFileSync(process.env.REPORT, JSON.stringify(results, null, 2));
