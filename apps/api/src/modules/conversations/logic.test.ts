import type { ConversationStatus, MessageStatus } from "@duckzap/contracts/conversations";
import { describe, expect, it } from "vitest";
import {
  INBOUND_STEPS,
  OUT_OF_HOURS_NOTICE_COOLDOWN_MS,
  aiTextFor,
  classifyInbound,
  computeAiDue,
  decideAutoMessage,
  generateSlots,
  initialConversationMode,
  inTab,
  isOptOutMessage,
  isVisibleTo,
  likePattern,
  nextMessageStatus,
  parseSlotId,
  previewOf,
  shouldRunAi,
  slotId,
  statusAfterInbound,
  toAiHours,
  trailingAgentCount,
  type Viewer,
  type VisibilityRow,
} from "./logic";

const viewer = (over: Partial<Viewer> = {}): Viewer => ({ id: "u1", canViewAll: false, teamIds: new Set(["t1"]), ...over });
const row = (over: Partial<VisibilityRow> = {}): VisibilityRow => ({ assigneeId: null, status: "ai_active", teamId: null, ...over });

describe("visibilidade (sem conversation.view_all)", () => {
  it("vê o que é dela", () => {
    expect(isVisibleTo(row({ assigneeId: "u1", status: "human_active" }), viewer())).toBe(true);
    expect(isVisibleTo(row({ assigneeId: "u1", status: "resolved" }), viewer())).toBe(true);
  });
  it("não vê conversa de outra pessoa, mesmo da sua equipe", () => {
    expect(isVisibleTo(row({ assigneeId: "u2", status: "human_active", teamId: "t1" }), viewer())).toBe(false);
  });
  it("a fila (Aguardando) de uma equipe é só dos membros dela; a fila sem equipe é de todos", () => {
    expect(isVisibleTo(row({ status: "handoff_requested", teamId: "t1" }), viewer())).toBe(true);
    expect(isVisibleTo(row({ status: "handoff_requested", teamId: "t9" }), viewer())).toBe(false);
    expect(isVisibleTo(row({ status: "handoff_requested", teamId: null }), viewer())).toBe(true);
  });
  it("quem não está em nenhuma equipe só vê a fila sem equipe", () => {
    const loose = viewer({ teamIds: new Set() });
    expect(isVisibleTo(row({ status: "handoff_requested", teamId: "t1" }), loose)).toBe(false);
    expect(isVisibleTo(row({ status: "handoff_requested", teamId: null }), loose)).toBe(true);
  });
  it("vê conversas sem responsável das suas equipes, não das outras", () => {
    expect(isVisibleTo(row({ status: "ai_active", teamId: "t1" }), viewer())).toBe(true);
    expect(isVisibleTo(row({ status: "ai_active", teamId: "t2" }), viewer())).toBe(false);
    expect(isVisibleTo(row({ status: "ai_active", teamId: null }), viewer())).toBe(false);
  });
  it("conversa resolvida sem responsável fica escondida", () => {
    expect(isVisibleTo(row({ status: "resolved", teamId: "t1" }), viewer())).toBe(false);
  });
  it("com view_all vê tudo", () => {
    expect(isVisibleTo(row({ assigneeId: "u2", status: "resolved", teamId: "t9" }), viewer({ canViewAll: true }))).toBe(true);
  });
});

describe("abas", () => {
  const all: ConversationStatus[] = ["ai_active", "handoff_requested", "human_active", "resolved"];
  it("Minhas: só abertas atribuídas a mim (assumi ou recebi por transferência)", () => {
    expect(inTab("mine", row({ assigneeId: "u1", status: "human_active" }), viewer())).toBe(true);
    expect(inTab("mine", row({ assigneeId: "u2", status: "human_active", teamId: "t1" }), viewer())).toBe(false);
    expect(inTab("mine", row({ assigneeId: null, status: "ai_active", teamId: "t1" }), viewer())).toBe(false);
    expect(inTab("mine", row({ assigneeId: null, status: "handoff_requested", teamId: "t1" }), viewer())).toBe(false);
    expect(inTab("mine", row({ assigneeId: "u1", status: "resolved" }), viewer())).toBe(false);
  });
  it("a fila da equipe fica só em Aguardando e o que a IA atende fica só em IA", () => {
    expect(inTab("waiting", row({ assigneeId: null, status: "handoff_requested", teamId: "t1" }), viewer())).toBe(true);
    expect(inTab("ai", row({ assigneeId: null, status: "handoff_requested", teamId: "t1" }), viewer())).toBe(false);
    expect(inTab("ai", row({ assigneeId: null, status: "ai_active", teamId: "t1" }), viewer())).toBe(true);
    expect(inTab("waiting", row({ status: "ai_active" }), viewer())).toBe(false);
  });
  it("IA: só ai_active (nem pessoa atendendo, nem resolvida)", () => {
    const all: ConversationStatus[] = ["ai_active", "handoff_requested", "human_active", "resolved"];
    expect(all.filter((status) => inTab("ai", row({ status }), viewer()))).toEqual(["ai_active"]);
  });
  it("Aguardando só tem handoff_requested", () => {
    expect(all.filter((status) => inTab("waiting", row({ status }), viewer()))).toEqual(["handoff_requested"]);
  });
  it("Todas existe só com view_all", () => {
    expect(inTab("all", row({ status: "human_active", assigneeId: "u2" }), viewer())).toBe(false);
    expect(inTab("all", row({ status: "human_active", assigneeId: "u2" }), viewer({ canViewAll: true }))).toBe(true);
    expect(inTab("all", row({ status: "resolved" }), viewer({ canViewAll: true }))).toBe(false);
  });
  it("Resolvidas", () => {
    expect(inTab("resolved", row({ status: "resolved" }), viewer())).toBe(true);
  });
});

describe("status de entrega é monotônico", () => {
  const order: MessageStatus[] = ["sending", "sent", "delivered", "read"];
  it("só avança", () => {
    expect(nextMessageStatus("sending", "sent")).toBe("sent");
    expect(nextMessageStatus("sent", "delivered")).toBe("delivered");
    expect(nextMessageStatus("delivered", "read")).toBe("read");
    expect(nextMessageStatus("sending", "read")).toBe("read");
  });
  it("nunca anda para trás nem repete", () => {
    for (const [i, current] of order.entries()) {
      for (const incoming of order.slice(0, i + 1)) {
        if (incoming === "sending") continue;
        expect(nextMessageStatus(current, incoming as "sent" | "delivered" | "read")).toBeNull();
      }
    }
  });
  it("failed só vale antes da entrega", () => {
    expect(nextMessageStatus("sending", "failed")).toBe("failed");
    expect(nextMessageStatus("sent", "failed")).toBe("failed");
    expect(nextMessageStatus("delivered", "failed")).toBeNull();
    expect(nextMessageStatus("read", "failed")).toBeNull();
    expect(nextMessageStatus("failed", "failed")).toBeNull();
  });
  it("uma mensagem que falhou não volta a 'enviada', mas uma entrega real a promove", () => {
    expect(nextMessageStatus("failed", "sent")).toBeNull();
    expect(nextMessageStatus("failed", "delivered")).toBe("delivered");
  });
  it("notas e mensagens recebidas (sem status) ignoram o evento", () => {
    expect(nextMessageStatus(null, "read")).toBeNull();
  });
});

describe("mensagem automática do canal (horário comercial)", () => {
  const now = new Date("2026-10-26T15:00:00Z");
  const base = { replyMode: "auto" as const, isNewConversation: true, withinHours: true, welcome: "Olá!", outOfHours: "Fechado.", outOfHoursNoticeAt: null, now };
  it("dentro do horário: boas-vindas só na conversa nova", () => {
    expect(decideAutoMessage(base)).toBe("welcome");
    expect(decideAutoMessage({ ...base, isNewConversation: false })).toBeNull();
    expect(decideAutoMessage({ ...base, welcome: "  " })).toBeNull();
  });
  it("fora do horário: aviso de fora do horário, nunca as duas mensagens", () => {
    expect(decideAutoMessage({ ...base, withinHours: false })).toBe("out_of_hours");
    expect(decideAutoMessage({ ...base, withinHours: false, isNewConversation: false })).toBe("out_of_hours");
  });
  it("no máximo um aviso de fora do horário a cada 12 h", () => {
    const recent = new Date(now.getTime() - OUT_OF_HOURS_NOTICE_COOLDOWN_MS + 60_000);
    const old = new Date(now.getTime() - OUT_OF_HOURS_NOTICE_COOLDOWN_MS - 60_000);
    expect(decideAutoMessage({ ...base, withinHours: false, outOfHoursNoticeAt: recent })).toBeNull();
    expect(decideAutoMessage({ ...base, withinHours: false, outOfHoursNoticeAt: old })).toBe("out_of_hours");
  });
  it("fora do horário sem aviso configurado cai nas boas-vindas da conversa nova", () => {
    expect(decideAutoMessage({ ...base, withinHours: false, outOfHours: "" })).toBe("welcome");
    expect(decideAutoMessage({ ...base, withinHours: false, outOfHours: "", isNewConversation: false })).toBeNull();
  });
  it("modo Somente IA nunca manda mensagem automática, mesmo com os textos preenchidos", () => {
    for (const isNewConversation of [true, false]) {
      for (const withinHours of [true, false]) {
        expect(decideAutoMessage({ ...base, replyMode: "ai", isNewConversation, withinHours })).toBeNull();
      }
    }
    expect(decideAutoMessage({ ...base, replyMode: "ai", withinHours: false, outOfHours: "" })).toBeNull();
  });
  it("modo Automático: matriz completa (conversa nova/antiga x dentro/fora do horário)", () => {
    const auto = { ...base, replyMode: "auto" as const };
    expect(decideAutoMessage({ ...auto, isNewConversation: true, withinHours: true })).toBe("welcome");
    expect(decideAutoMessage({ ...auto, isNewConversation: false, withinHours: true })).toBeNull();
    expect(decideAutoMessage({ ...auto, isNewConversation: true, withinHours: false })).toBe("out_of_hours");
    expect(decideAutoMessage({ ...auto, isNewConversation: false, withinHours: false })).toBe("out_of_hours");
  });
  it("conversa nova nasce sem IA no modo Automático e com IA (se houver agente) no Somente IA", () => {
    expect(initialConversationMode("auto", true)).toBe("human");
    expect(initialConversationMode("auto", false)).toBe("human");
    expect(initialConversationMode("ai", true)).toBe("ai");
    expect(initialConversationMode("ai", false)).toBe("human");
  });
  it("converte o horário de Ajustes para o formato da IA (0 = domingo)", () => {
    const hours = toAiHours(
      [
        { day: 1, open: true, start: "08:00", end: "18:00" },
        { day: 0, open: false, start: "08:00", end: "12:00" },
        { day: 2, open: true, start: "09:00", end: "12:00" },
        { day: 3, open: false, start: "08:00", end: "12:00" },
        { day: 4, open: false, start: "08:00", end: "12:00" },
        { day: 5, open: false, start: "08:00", end: "12:00" },
        { day: 6, open: false, start: "08:00", end: "12:00" },
      ],
      "America/Sao_Paulo",
    );
    expect(hours.days[0]).toBeNull();
    expect(hours.days[1]).toEqual(["08:00", "18:00"]);
    expect(hours.days[2]).toEqual(["09:00", "12:00"]);
  });
});

describe("opt-out vem primeiro", () => {
  it("o pipeline trata contato e opt-out antes de conversa, mensagem automática, lembrete e IA", () => {
    const index = (step: (typeof INBOUND_STEPS)[number]) => INBOUND_STEPS.indexOf(step);
    expect(index("opt_out")).toBeGreaterThan(index("contact")); // precisa do contato para registrar
    for (const later of ["consent_reply", "conversation", "store_message", "bookkeeping", "auto_message", "reminder_reply", "ai"] as const) {
      expect(index("opt_out")).toBeLessThan(index(later));
    }
    expect(INBOUND_STEPS[0]).toBe("dedupe");
  });
  it.each(["SAIR", "sair", "Parar", "PARAR!", "cancelar", "quero sair", "stop", "descadastrar"])("%s é pedido de saída", (text) => {
    expect(isOptOutMessage(text)).toBe(true);
    expect(classifyInbound(text).optOut).toBe(true);
  });
  it.each(["quero cancelar minha consulta", "preciso cancelar o agendamento de amanhã", "cancelar pedido", "posso parar na recepção?", "bom dia", "", "sair às 18h pode?"])(
    "%j NÃO é pedido de saída",
    (text) => {
      expect(isOptOutMessage(text)).toBe(false);
    },
  );
  it("mídia sem texto nunca é opt-out", () => {
    expect(classifyInbound(undefined).optOut).toBe(false);
  });
});

describe("para onde vai a conversa quando o cliente escreve", () => {
  it("modo IA com agente ativo: a IA atende", () => {
    expect(statusAfterInbound({ status: "ai_active", mode: "ai", assigneeId: null }, true)).toEqual({ status: "ai_active", queued: false });
  });
  it("modo IA: se uma pessoa já assumiu ou a fila espera, nada muda", () => {
    expect(statusAfterInbound({ status: "human_active", mode: "ai", assigneeId: "u1" }, true)).toEqual({ status: "human_active", queued: false });
    expect(statusAfterInbound({ status: "handoff_requested", mode: "ai", assigneeId: null }, true)).toEqual({ status: "handoff_requested", queued: true });
  });
  it("Só humano e Copiloto sem responsável vão para a fila; com responsável seguem com ele", () => {
    expect(statusAfterInbound({ status: "ai_active", mode: "human", assigneeId: null }, false)).toEqual({ status: "handoff_requested", queued: true });
    expect(statusAfterInbound({ status: "ai_active", mode: "copilot", assigneeId: null }, true)).toEqual({ status: "handoff_requested", queued: true });
    expect(statusAfterInbound({ status: "ai_active", mode: "human", assigneeId: "u1" }, false)).toEqual({ status: "human_active", queued: false });
  });
  it("modo IA sem agente ativo cai na fila", () => {
    expect(statusAfterInbound({ status: "ai_active", mode: "ai", assigneeId: null }, false)).toEqual({ status: "handoff_requested", queued: true });
  });
  it("quando a IA roda", () => {
    expect(shouldRunAi({ mode: "ai", status: "ai_active" }, true)).toBe("live");
    expect(shouldRunAi({ mode: "ai", status: "ai_active" }, false)).toBeNull();
    expect(shouldRunAi({ mode: "ai", status: "handoff_requested" }, true)).toBeNull();
    expect(shouldRunAi({ mode: "ai", status: "human_active" }, true)).toBeNull();
    expect(shouldRunAi({ mode: "copilot", status: "handoff_requested" }, true)).toBe("copilot");
    expect(shouldRunAi({ mode: "copilot", status: "resolved" }, true)).toBeNull();
    expect(shouldRunAi({ mode: "human", status: "handoff_requested" }, true)).toBeNull();
  });
});

describe("rajada (burst)", () => {
  const t0 = new Date("2026-10-26T12:00:00.000Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);
  it("primeira mensagem: prazo = janela", () => {
    const d = computeAiDue({ now: t0, burstStartedAt: null, windowMs: 4000, maxWaitMs: 5000 });
    expect(d.startedAt).toEqual(t0);
    expect(d.dueAt).toEqual(at(4000));
  });
  it("mensagem seguinte empurra o prazo, mas só até o teto contado do início", () => {
    const d = computeAiDue({ now: at(3000), burstStartedAt: t0, windowMs: 4000, maxWaitMs: 5000 });
    expect(d.dueAt).toEqual(at(5000));
    expect(d.startedAt).toEqual(t0);
  });
  it("depois do teto não adia mais (responde na hora)", () => {
    const d = computeAiDue({ now: at(5500), burstStartedAt: t0, windowMs: 4000, maxWaitMs: 5000 });
    expect(d.dueAt).toEqual(at(5500));
  });
  it("rajada velha demais começa outra", () => {
    const d = computeAiDue({ now: at(60_000), burstStartedAt: t0, windowMs: 4000, maxWaitMs: 5000 });
    expect(d.startedAt).toEqual(at(60_000));
    expect(d.dueAt).toEqual(at(64_000));
  });
  it("janela zero responde na hora", () => {
    expect(computeAiDue({ now: t0, burstStartedAt: null, windowMs: 0, maxWaitMs: 0 }).dueAt).toEqual(t0);
  });
  it("conta as mensagens seguidas da IA no fim do histórico", () => {
    expect(trailingAgentCount([{ role: "customer" }, { role: "agent" }, { role: "agent" }])).toBe(2);
    expect(trailingAgentCount([{ role: "agent" }, { role: "customer" }])).toBe(0);
    expect(trailingAgentCount([{ role: "customer" }, { role: "agent" }, { role: "human" }])).toBe(0);
  });
});

describe("texto da lista e da IA", () => {
  it("prévia achata espaços e corta o excesso", () => {
    expect(previewOf("  oi\n\n tudo   bem ")).toBe("oi tudo bem");
    expect(previewOf("x".repeat(300))).toHaveLength(160);
  });
  it("a IA vê um marcador no lugar da mídia sem legenda", () => {
    expect(aiTextFor("audio", "")).toContain("áudio");
    expect(aiTextFor("image", "veja")).toBe("veja");
    expect(aiTextFor("text", "")).toBe("");
  });
  it("a busca do cliente não vira curinga", () => {
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
});

describe("horários livres para a IA", () => {
  const hours = [
    { day: 0 as const, open: false, start: "08:00", end: "12:00" },
    { day: 1 as const, open: true, start: "08:00", end: "10:00" },
    { day: 2 as const, open: true, start: "08:00", end: "10:00" },
    { day: 3 as const, open: false, start: "08:00", end: "12:00" },
    { day: 4 as const, open: false, start: "08:00", end: "12:00" },
    { day: 5 as const, open: false, start: "08:00", end: "12:00" },
    { day: 6 as const, open: false, start: "08:00", end: "12:00" },
  ];
  const now = new Date("2026-11-01T12:00:00Z"); // domingo
  const base = { fromDay: "2026-11-02", toDay: "2026-11-02", hours, timeZone: "America/Sao_Paulo", durationMinutes: 60, busy: [], now };
  it("gera de 30 em 30 min dentro do expediente (segunda 08–10, 60 min)", () => {
    const slots = generateSlots(base).map((s) => s.toISOString());
    expect(slots).toEqual(["2026-11-02T11:00:00.000Z", "2026-11-02T11:30:00.000Z", "2026-11-02T12:00:00.000Z"]);
  });
  it("dia fechado não tem horário", () => {
    expect(generateSlots({ ...base, fromDay: "2026-11-01", toDay: "2026-11-01" })).toEqual([]);
  });
  it("pula horários ocupados e os muito próximos", () => {
    const busy = [{ start: new Date("2026-11-02T11:00:00Z"), end: new Date("2026-11-02T12:00:00Z") }];
    expect(generateSlots({ ...base, busy }).map((s) => s.toISOString())).toEqual(["2026-11-02T12:00:00.000Z"]);
    // antecedência mínima de 1 h: às 11:20Z o primeiro horário possível seria 12:20Z, e o expediente acaba 13:00Z (60 min)
    expect(generateSlots({ ...base, now: new Date("2026-11-02T11:20:00Z") })).toEqual([]);
  });
  it("o id do horário carrega o instante e só vale para o tipo certo", () => {
    const at = new Date("2026-11-02T11:00:00.000Z");
    const id = slotId("tipo-1", at);
    expect(id).toBe("slot:tipo-1:2026-11-02T11:00:00Z");
    expect(parseSlotId(id, "tipo-1")).toEqual(at);
    expect(parseSlotId(id, "tipo-2")).toBeNull();
    expect(parseSlotId("slot:tipo-1:lixo", "tipo-1")).toBeNull();
  });
  it("datas inválidas não geram nada", () => {
    expect(generateSlots({ ...base, fromDay: "amanhã" })).toEqual([]);
    expect(generateSlots({ ...base, fromDay: "2026-11-05", toDay: "2026-11-02" })).toEqual([]);
  });
});
