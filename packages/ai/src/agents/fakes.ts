import { normalize } from "./text";
import {
  PortError,
  type AgentPorts,
  type AppointmentInfo,
  type AppointmentTypeInfo,
  type ContactInfo,
  type KnowledgeHit,
  type ProductInfo,
  type Scope,
  type Slot,
} from "./types";

/**
 * Portas em memória: usadas nos testes, nos evals e no SIMULADOR (dados fictícios, nada persiste).
 * As implementações reais (Clientes/Agenda/Conversas) entram na integração.
 */

export const FICTIONAL_TYPES: AppointmentTypeInfo[] = [
  { id: "apt_limpeza", name: "Limpeza", durationMinutes: 45, staffOnly: false },
  { id: "apt_avaliacao", name: "Avaliação", durationMinutes: 30, staffOnly: false },
  { id: "apt_clareamento", name: "Clareamento", durationMinutes: 60, staffOnly: false },
  { id: "apt_restauracao", name: "Restauração", durationMinutes: 60, staffOnly: false },
  { id: "apt_canal", name: "Canal", durationMinutes: 90, staffOnly: true },
];

export type FakeState = {
  types: AppointmentTypeInfo[];
  appointments: (AppointmentInfo & { contactId: string })[];
  contact: ContactInfo;
  chunks: { id: string; documentName: string | null; text: string }[];
  writes: { port: string; method: string; args: unknown }[];
  humanRequests: string[];
  optOut: boolean;
  /** Produtos DISPONÍVEIS do catálogo fictício (a porta só enxerga estes). */
  products: ProductInfo[];
  /** Notas internas que a IA deixou na conversa. */
  notes: string[];
};

function slotFor(typeId: string, day: Date, hh: number, mm: number): Slot {
  const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh + 3, mm)); // -03:00
  const iso = d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return { id: `slot:${typeId}:${iso}`, typeId, startsAt: iso };
}

export function createInMemoryPorts(
  seed: Partial<Pick<FakeState, "types" | "chunks" | "appointments" | "contact" | "products">> & { now?: () => Date } = {},
): { ports: AgentPorts; state: FakeState } {
  const state: FakeState = {
    types: seed.types ?? FICTIONAL_TYPES,
    appointments: seed.appointments ?? [],
    contact: seed.contact ?? { name: "Cliente de teste", email: null, phone: "+55 11 91234-5678", tags: [] },
    chunks: seed.chunks ?? [],
    writes: [],
    humanRequests: [],
    optOut: false,
    products: seed.products ?? [],
    notes: [],
  };
  const clock = seed.now ?? (() => new Date());
  const log = (port: string, method: string, args: unknown) => state.writes.push({ port, method, args });

  const ports: AgentPorts = {
    knowledge: {
      async search(_scope: Scope, query: string, limit: number): Promise<KnowledgeHit[]> {
        const words = normalize(query).replace(/[^a-z0-9 ]/g, " ").split(" ").filter((w) => w.length >= 4);
        return state.chunks
          .map((c) => {
            const text = normalize(c.text);
            return { c, score: words.filter((w) => text.includes(w)).length };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((x) => ({ id: x.c.id, documentName: x.c.documentName, text: x.c.text, score: x.score }));
      },
    },
    agenda: {
      async getType(_s, typeId) {
        return state.types.find((t) => t.id === typeId) ?? null;
      },
      async listAvailableSlots(_s, q) {
        const start = new Date(`${q.from}T00:00:00Z`);
        const end = new Date(`${q.to}T00:00:00Z`);
        const out: Slot[] = [];
        for (let d = new Date(start); d <= end && out.length < 12; d = new Date(d.getTime() + 86_400_000)) {
          if (d.getUTCDay() === 0 || d < new Date(clock().toISOString().slice(0, 10) + "T00:00:00Z")) continue;
          // horário que já passou hoje não é oferecido (a agenda real também não oferece)
          for (const slot of [slotFor(q.typeId, d, 8, 30), slotFor(q.typeId, d, 14, 0)]) {
            if (Date.parse(slot.startsAt) > clock().getTime()) out.push(slot);
          }
        }
        return out;
      },
      async listContactAppointments(s) {
        return state.appointments.filter((a) => a.contactId === s.contactId).map(({ contactId: _c, ...a }) => a);
      },
      async bookAppointment(s, input) {
        log("agenda", "bookAppointment", input);
        const startsAt = input.slotId.split(":").slice(2).join(":");
        const a = { id: `apt_${state.appointments.length + 1}`, typeId: input.typeId, startsAt, status: "confirmed" as const, contactId: s.contactId };
        state.appointments.push(a);
        return { id: a.id, typeId: a.typeId, startsAt: a.startsAt, status: a.status };
      },
      async rescheduleAppointment(s, input) {
        log("agenda", "rescheduleAppointment", input);
        const a = state.appointments.find((x) => x.id === input.appointmentId && x.contactId === s.contactId);
        if (!a) throw new PortError("not_found", "Agendamento não encontrado para este cliente.");
        a.startsAt = input.slotId.split(":").slice(2).join(":");
        a.status = "confirmed";
        return { id: a.id, typeId: a.typeId, startsAt: a.startsAt, status: a.status };
      },
      async cancelAppointment(s, input) {
        log("agenda", "cancelAppointment", input);
        const a = state.appointments.find((x) => x.id === input.appointmentId && x.contactId === s.contactId);
        if (!a) throw new PortError("not_found", "Agendamento não encontrado para este cliente.");
        a.status = "canceled";
      },
    },
    contacts: {
      async getContact() {
        return state.contact;
      },
      async updateFields(_s, fields) {
        log("contacts", "updateFields", fields);
        state.contact = { ...state.contact, ...fields };
      },
      async addTag(_s, tag) {
        log("contacts", "addTag", tag);
        state.contact = { ...state.contact, tags: [...state.contact.tags, tag] };
      },
    },
    conversations: {
      async requestHuman(_s, reason) {
        log("conversations", "requestHuman", reason);
        state.humanRequests.push(reason);
      },
      async scheduleFollowup(_s, input) {
        log("conversations", "scheduleFollowup", input);
      },
      async markOptOut() {
        log("conversations", "markOptOut", null);
        state.optOut = true;
      },
      async addInternalNote(_s, text) {
        log("conversations", "addInternalNote", text);
        state.notes.push(text);
      },
    },
    catalog: {
      async listAvailable() {
        return state.products;
      },
      async getProduct(_s, productId) {
        return state.products.find((p) => p.id === productId) ?? null;
      },
    },
  };
  return { ports, state };
}

/** Portas do simulador: agenda/contato FICTÍCIOS (tipos reais da empresa, só leitura) + conhecimento real (só leitura). */
export function createSimulatorPorts(options: { knowledge?: AgentPorts["knowledge"]; types?: AppointmentTypeInfo[]; now?: () => Date } = {}) {
  const { ports, state } = createInMemoryPorts({ types: options.types, now: options.now });
  return { ports: options.knowledge ? { ...ports, knowledge: options.knowledge } : ports, state };
}
