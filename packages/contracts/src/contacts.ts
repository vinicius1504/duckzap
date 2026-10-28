import { z } from "zod";

// Clientes (CRM): contatos, etiquetas (as 4 primeiras são as etapas do funil), listas estáticas,
// segmentos dinâmicos (filtro salvo) e consentimento de disparo (opt-in, INSTRUCTIONS §5.7 item 7).

/** Estado do opt-in. `null` no contato = nunca recebeu convite. */
export const consentStatusSchema = z.enum(["pending", "granted", "denied", "expired"]);
export type ConsentStatus = z.infer<typeof consentStatusSchema>;

/** Origem legítima do contato. Sem origem, não pode receber convite de consentimento. */
export const contactOriginSchema = z.enum([
  "customer", // já é cliente
  "service", // deixou o número em atendimento
  "form", // formulário (site, ficha)
  "walk_in", // balcão / recepção
  "event", // evento
  "referral", // indicação
  "inbound", // mandou mensagem primeiro (não recebe convite: o agente pergunta na conversa)
]);
export type ContactOrigin = z.infer<typeof contactOriginSchema>;

/** Origens que podem ser declaradas numa importação (inbound só nasce de conversa). */
export const importOriginSchema = contactOriginSchema.exclude(["inbound"]);
export type ImportOrigin = z.infer<typeof importOriginSchema>;

export const contactChannelSchema = z.enum(["whatsapp", "instagram"]);
export type ContactChannel = z.infer<typeof contactChannelSchema>;

export const consentSchema = z.object({
  status: consentStatusSchema,
  /** Como o consentimento foi pedido/registrado. */
  method: z.enum(["invite", "conversation", "form"]),
  /** Última mudança de estado. */
  updatedAt: z.iso.datetime(),
  inviteSentAt: z.iso.datetime().nullable(),
  /** Texto exato enviado (prova). */
  inviteText: z.string().nullable(),
  /** Resposta do contato (prova). */
  replyText: z.string().nullable(),
  repliedAt: z.iso.datetime().nullable(),
  channelName: z.string().nullable(),
});
export type Consent = z.infer<typeof consentSchema>;

export const contactSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** E.164, ex.: +5567998123456. Contato só do Instagram pode não ter. */
  phone: z.string().nullable(),
  email: z.email().nullable(),
  instagram: z.string().nullable(),
  channel: contactChannelSchema,
  isCustomer: z.boolean(),
  tagIds: z.array(z.string()),
  listIds: z.array(z.string()),
  origin: contactOriginSchema.nullable(),
  originNote: z.string().nullable(),
  consent: consentSchema.nullable(),
  ownerId: z.string().nullable(),
  birthDate: z.iso.date().nullable(),
  createdAt: z.iso.datetime(),
  lastInteractionAt: z.iso.datetime().nullable(),
});
export type Contact = z.infer<typeof contactSchema>;

export const tagColorSchema = z.enum(["ink", "duck", "slate", "ok", "info", "warn", "err"]);
export type TagColor = z.infer<typeof tagColorSchema>;

export const FUNNEL_STAGE_COUNT = 4;

export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  color: tagColorSchema,
  /** 0-based. As posições 0–3 são as etapas do funil (colunas do Quadro em Conversas). */
  position: z.number().int().min(0),
  contactCount: z.number().int(),
});
export type Tag = z.infer<typeof tagSchema>;

export const tagInputSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome à etiqueta.").max(40),
  description: z.string().trim().max(120),
  color: tagColorSchema,
});
export type TagInput = z.infer<typeof tagInputSchema>;

export const consentFilterSchema = z.enum(["granted", "pending", "denied", "expired", "none"]);
export type ConsentFilter = z.infer<typeof consentFilterSchema>;

/** Filtro de contatos. É também o que um segmento dinâmico guarda. */
export const contactFilterSchema = z.object({
  q: z.string().trim().max(100).optional(),
  tagId: z.string().optional(),
  isCustomer: z.boolean().optional(),
  consent: consentFilterSchema.optional(),
  createdWithinDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
  /** Sem interação há pelo menos N dias. */
  inactiveDays: z.union([z.literal(30), z.literal(90), z.literal(180)]).optional(),
  birthMonth: z.number().int().min(1).max(12).optional(),
});
export type ContactFilter = z.infer<typeof contactFilterSchema>;

export const contactListQuerySchema = contactFilterSchema.extend({
  listId: z.string().optional(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
});
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;

export const contactPageSchema = z.object({
  items: z.array(contactSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** Totais da base inteira (cabeçalho: "1.284 pessoas · 912 aceitam receber campanhas"). */
  overall: z.object({ contacts: z.number().int(), granted: z.number().int() }),
});
export type ContactPage = z.infer<typeof contactPageSchema>;

export const contactListKindSchema = z.enum(["static", "segment"]);
export type ContactListKind = z.infer<typeof contactListKindSchema>;

export const contactListSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: contactListKindSchema,
  description: z.string(),
  /** Só segmentos. */
  filter: contactFilterSchema.nullable(),
  memberCount: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type ContactList = z.infer<typeof contactListSchema>;

export const contactListInputSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome à lista.").max(60),
  description: z.string().trim().max(160),
  kind: contactListKindSchema,
  filter: contactFilterSchema.nullable(),
});
export type ContactListInput = z.infer<typeof contactListInputSchema>;

export const contactNoteSchema = z.object({
  id: z.string(),
  text: z.string(),
  authorName: z.string(),
  createdAt: z.iso.datetime(),
});
export type ContactNote = z.infer<typeof contactNoteSchema>;

export const contactEventSchema = z.object({
  id: z.string(),
  kind: z.enum(["conversation", "appointment", "campaign", "consent", "tag", "import", "created"]),
  title: z.string(),
  detail: z.string().nullable(),
  at: z.iso.datetime(),
});
export type ContactEvent = z.infer<typeof contactEventSchema>;

export const contactDetailSchema = contactSchema.extend({
  notes: z.array(contactNoteSchema),
  history: z.array(contactEventSchema),
  ownerName: z.string().nullable(),
});
export type ContactDetail = z.infer<typeof contactDetailSchema>;

const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[^\d+]/g, ""))
  .refine((v) => v === "" || /^\+?\d{10,13}$/.test(v), "Telefone inválido. Use DDD + número, ex.: 67 99812-3456.");

export const contactInputSchema = z
  .object({
    name: z.string().trim().min(1, "Informe o nome.").max(120),
    phone: phoneSchema,
    email: z.union([z.literal(""), z.email("E-mail inválido.")]),
    instagram: z.string().trim().max(60),
    isCustomer: z.boolean(),
    tagIds: z.array(z.string()),
    origin: contactOriginSchema,
    originNote: z.string().trim().max(160),
    ownerId: z.string().nullable(),
    birthDate: z.union([z.literal(""), z.iso.date()]),
  })
  .refine((v) => v.phone !== "" || v.instagram !== "", {
    message: "Informe o telefone ou o Instagram.",
    path: ["phone"],
  });
export type ContactInput = z.input<typeof contactInputSchema>;

// Importação de planilha -------------------------------------------------------------------------

export const importFieldSchema = z.enum(["name", "phone", "email", "birthDate", "note", "ignore"]);
export type ImportField = z.infer<typeof importFieldSchema>;

export const importPreviewSchema = z.object({
  importId: z.string(),
  fileName: z.string(),
  columns: z.array(z.object({ key: z.string(), header: z.string(), suggested: importFieldSchema })),
  sampleRows: z.array(z.record(z.string(), z.string())),
  totalRows: z.number().int(),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

export const RELATIONSHIP_CONFIRMATION = "Estes contatos têm relação com a minha empresa e não foram comprados";

export const importCommitSchema = z.object({
  importId: z.string(),
  mapping: z.record(z.string(), importFieldSchema),
  origin: importOriginSchema,
  originNote: z.string().trim().max(160),
  /** Obrigatório (§5.7 item 7). */
  confirmedRelationship: z.literal(true, { error: `Confirme: “${RELATIONSHIP_CONFIRMATION}”.` }),
  tagIds: z.array(z.string()),
  listId: z.string().nullable(),
});
export type ImportCommit = z.infer<typeof importCommitSchema>;

export const importResultSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.array(z.object({ row: z.number().int(), reason: z.enum(["no_phone", "invalid_phone", "duplicate"]) })),
});
export type ImportResult = z.infer<typeof importResultSchema>;

// Importação do WhatsApp -------------------------------------------------------------------------
// Traz as pessoas que o WhatsApp conectado ao canal conhece (agenda do aparelho). A pessoa revisa a lista (marca, desmarca
// e corrige nomes) e termina pelos mesmos passos da planilha (origem, etiquetas, lista e confirmação de relação).

export const WHATSAPP_IMPORT_MAX_ROWS = 20_000;

export const whatsappImportStartSchema = z.object({ channelId: z.string() });
export type WhatsappImportStart = z.infer<typeof whatsappImportStartSchema>;

export const whatsappCandidateSchema = z.object({
  /** E.164 (+55…): o mesmo formato guardado em Clientes, para não duplicar. */
  phone: z.string(),
  /** Nome que o WhatsApp trouxe; "" quando não há um nome útil (vazio ou igual ao número). A pessoa corrige na revisão. */
  name: z.string(),
  /** Já existe em Clientes (mesmo telefone): marcar só atualiza etiqueta/lista, não duplica. */
  existing: z.boolean(),
});
export type WhatsappCandidate = z.infer<typeof whatsappCandidateSchema>;

export const whatsappImportPreviewSchema = z.object({
  importId: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  candidates: z.array(whatsappCandidateSchema),
  /** O que o WhatsApp devolveu e o que ficou de fora (para a tela explicar os números). */
  summary: z.object({
    found: z.number().int(),
    people: z.number().int(),
    existing: z.number().int(),
    groups: z.number().int(),
    /** Contatos de ID oculto (sem número visível): não dá para importar. */
    hidden: z.number().int(),
    other: z.number().int(),
    noName: z.number().int(),
  }),
});
export type WhatsappImportPreview = z.infer<typeof whatsappImportPreviewSchema>;

export const whatsappImportCommitSchema = z.object({
  importId: z.string(),
  /** Seleção final: só telefones que vieram da prévia; o nome pode ter sido corrigido. */
  rows: z.array(z.object({ phone: z.string(), name: z.string().trim().max(120) })).min(1, "Marque ao menos um contato.").max(WHATSAPP_IMPORT_MAX_ROWS),
  origin: importOriginSchema,
  originNote: z.string().trim().max(160),
  confirmedRelationship: z.literal(true, { error: `Confirme: “${RELATIONSHIP_CONFIRMATION}”.` }),
  tagIds: z.array(z.string()),
  listId: z.string().nullable(),
});
export type WhatsappImportCommit = z.infer<typeof whatsappImportCommitSchema>;

// Convite de consentimento (§5.7 item 7) ----------------------------------------------------------

export const INVITE_DAILY_LIMIT = 20;
export const CHANNEL_DAILY_LIMIT = 50;

export const inviteIneligibleReasonSchema = z.enum([
  "already_invited", // uma vez só por contato, para sempre
  "has_consent", // já aceitou ou recusou
  "no_origin",
  "inbound", // mandou mensagem primeiro
  "no_phone",
]);
export type InviteIneligibleReason = z.infer<typeof inviteIneligibleReasonSchema>;

export const inviteChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(["qr", "official"]),
  connected: z.boolean(),
  invitesSentToday: z.number().int(),
  inviteDailyLimit: z.number().int(),
  messagesSentToday: z.number().int(),
  channelDailyLimit: z.number().int(),
  /** Dia de aquecimento do número novo (1–7), ou null se já aquecido. */
  warmupDay: z.number().int().nullable(),
});
export type InviteChannel = z.infer<typeof inviteChannelSchema>;

export const inviteOverviewSchema = z.object({
  channels: z.array(inviteChannelSchema),
  /** Texto base do convite: identificação + motivo + pergunta. Sem oferta, preço, link ou mídia. */
  messageTemplate: z.string(),
  /** Convite automático para novos contatos: desligado por padrão. */
  autoInviteEnabled: z.boolean(),
  sendWindow: z.object({ start: z.string(), end: z.string(), sundays: z.boolean() }),
  /** Toda a base: quem pode receber o convite agora e por que os outros não podem. */
  eligibleContactIds: z.array(z.string()),
  ineligibleCounts: z.record(inviteIneligibleReasonSchema, z.number().int()),
});
export type InviteOverview = z.infer<typeof inviteOverviewSchema>;

export const inviteRequestSchema = z.object({
  contactIds: z.array(z.string()).min(1, "Selecione ao menos um contato."),
  channelId: z.string().min(1, "Escolha o número que vai enviar."),
});
export type InviteRequest = z.infer<typeof inviteRequestSchema>;

export const inviteResultSchema = z.object({
  queued: z.number().int(),
  /** Quantos por dia (ex.: [20, 14] = hoje 20, amanhã 14). */
  days: z.array(z.number().int()),
  skipped: z.array(z.object({ contactId: z.string(), reason: inviteIneligibleReasonSchema })),
});
export type InviteResult = z.infer<typeof inviteResultSchema>;

/** Regra de elegibilidade do convite (a verdade é do back; a UI usa para explicar). */
export function inviteIneligibility(contact: Pick<Contact, "consent" | "origin" | "phone">): InviteIneligibleReason | null {
  if (contact.consent?.status === "granted" || contact.consent?.status === "denied") return "has_consent";
  if (contact.consent) return "already_invited";
  if (!contact.phone) return "no_phone";
  if (!contact.origin) return "no_origin";
  if (contact.origin === "inbound") return "inbound";
  return null;
}

/** Divide `total` em dias respeitando o que ainda cabe hoje e o limite diário. */
export function splitIntoDays(total: number, remainingToday: number, dailyLimit: number): number[] {
  const days: number[] = [];
  let left = total;
  const first = Math.max(0, Math.min(remainingToday, left));
  if (first > 0) {
    days.push(first);
    left -= first;
  } else if (left > 0) {
    days.push(0);
  }
  while (left > 0 && dailyLimit > 0) {
    const n = Math.min(dailyLimit, left);
    days.push(n);
    left -= n;
  }
  return days;
}

export const exportRequestSchema = z.object({
  contactIds: z.array(z.string()).nullable(),
  filter: contactListQuerySchema.omit({ page: true, pageSize: true }).nullable(),
});
export type ExportRequest = z.infer<typeof exportRequestSchema>;
