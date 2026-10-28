import { z } from "zod";

// Campanhas (§1.1 módulo 5) + motor de envio seguro para canais QR (§5.7).
// As regras do motor rodam no worker; as funções puras abaixo existem para a UI
// mostrar a mesma conta que o servidor fará (divisão em dias, validação de variações).

export const campaignStatusSchema = z.enum(["draft", "scheduled", "sending", "paused", "completed", "canceled"]);
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;

export const campaignMessageTypeSchema = z.enum(["text", "text_image", "buttons", "list"]);
export type CampaignMessageType = z.infer<typeof campaignMessageTypeSchema>;

/** Motivo da parada automática (circuit breaker, §5.7 item 5) ou manual. */
export const campaignPauseReasonSchema = z.enum([
  "manual",
  "channel_disconnected",
  "high_failure_rate",
  "opt_outs",
  "provider_restriction",
  "outside_window",
  "subscription_expired",
]);
export type CampaignPauseReason = z.infer<typeof campaignPauseReasonSchema>;

// ---------- canais e público ----------

export const campaignChannelKindSchema = z.enum(["whatsapp_qr", "whatsapp_official"]);
export type CampaignChannelKind = z.infer<typeof campaignChannelKindSchema>;

export const campaignChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: campaignChannelKindSchema,
  connected: z.boolean(),
  /** Dia de uso do número desde a conexão (1 = primeiro dia). Define o aquecimento. */
  numberAgeDays: z.number().int().min(1),
  /** Limite diário de campanha já calculado pelo servidor (aquecimento incluído). */
  dailyLimit: z.number().int().min(0),
  hourlyLimit: z.number().int().min(0),
  sentToday: z.number().int().min(0),
  /** O que o provedor do canal suporta; sem botões/lista a mensagem cai para opções numeradas (§3.6). */
  capabilities: z.object({ buttons: z.boolean(), lists: z.boolean(), templates: z.boolean(), media: z.boolean() }).optional(),
});
export type CampaignChannel = z.infer<typeof campaignChannelSchema>;

export const audienceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["list", "segment"]),
  total: z.number().int(),
  /** Contatos com opt-in registrado (consent = granted). Só eles recebem. */
  optedIn: z.number().int(),
  notOptedIn: z.number().int(),
  optedOut: z.number().int(),
  duplicates: z.number().int(),
  /** Contatos que conversaram com a empresa nos últimos 90 dias (têm prioridade). */
  recentlyActive: z.number().int(),
});
export type Audience = z.infer<typeof audienceSchema>;

// ---------- mensagem ----------

export const DEFAULT_OPT_OUT_LINE = "Responda SAIR para não receber mais.";
export const CAMPAIGN_VARIABLES = ["{nome}", "{empresa}", "{ultima_visita}"] as const;

export const campaignMessageSchema = z.object({
  type: campaignMessageTypeSchema,
  body: z.string().max(1024),
  imageName: z.string().nullable(),
  buttons: z.array(z.string().trim().min(1).max(20)).max(3),
  listButtonLabel: z.string().max(20),
  listItems: z.array(z.object({ title: z.string().trim().min(1).max(24), description: z.string().max(72) })).max(10),
  /** Linha de saída obrigatória; sempre no fim da mensagem. */
  optOutLine: z.string().min(1),
  /** Canal oficial: id do modelo aprovado pela Meta (corpo não editável). */
  officialTemplateId: z.string().nullable(),
});
export type CampaignMessage = z.infer<typeof campaignMessageSchema>;

export const variationIssueSchema = z.enum([
  "missing_variable",
  "missing_link",
  "missing_opt_out",
  "unknown_number_or_link",
  "too_similar",
  "too_different",
]);
export type VariationIssue = z.infer<typeof variationIssueSchema>;

export const messageVariationSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** Revisão do usuário; só "approved" entra no sorteio do envio. */
  review: z.enum(["pending", "approved", "rejected"]),
  issues: z.array(variationIssueSchema),
});
export type MessageVariation = z.infer<typeof messageVariationSchema>;

export const variationModeSchema = z.enum(["bank", "per_message"]);
export type VariationMode = z.infer<typeof variationModeSchema>;

export const MIN_VARIATIONS = 15;
export const MAX_VARIATIONS = 30;
/** Mínimo de variações aprovadas (e nenhuma pendente) para disparar em canal QR. */
export const MIN_APPROVED_VARIATIONS = 10;

// ---------- envio ----------

export const INTERVAL_FLOOR_SECONDS = 30;

export const campaignSendingSchema = z
  .object({
    channelId: z.string(),
    scheduleMode: z.enum(["now", "scheduled"]),
    scheduledAt: z.iso.datetime().nullable(),
    intervalMinSeconds: z.number().int().min(INTERVAL_FLOOR_SECONDS).max(600),
    intervalMaxSeconds: z.number().int().min(INTERVAL_FLOOR_SECONDS).max(900),
    windowStart: z.string().regex(/^\d{2}:\d{2}$/),
    windowEnd: z.string().regex(/^\d{2}:\d{2}$/),
    skipSundaysAndHolidays: z.boolean(),
  })
  .refine((s) => s.intervalMaxSeconds > s.intervalMinSeconds, {
    path: ["intervalMaxSeconds"],
    message: "O máximo precisa ser maior que o mínimo.",
  });
export type CampaignSending = z.infer<typeof campaignSendingSchema>;

// ---------- campanha ----------

export const campaignStatsSchema = z.object({
  total: z.number().int(),
  sent: z.number().int(),
  delivered: z.number().int(),
  failed: z.number().int(),
  replied: z.number().int(),
  optedOut: z.number().int(),
});
export type CampaignStats = z.infer<typeof campaignStatsSchema>;

export const campaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: campaignStatusSchema,
  audienceId: z.string().nullable(),
  audienceName: z.string().nullable(),
  message: campaignMessageSchema,
  variationMode: variationModeSchema,
  variations: z.array(messageVariationSchema),
  /** Mensagem base usada para gerar o banco; se a base mudar, o banco precisa ser gerado de novo. */
  variationsBase: z.string().nullable(),
  sending: campaignSendingSchema,
  channelName: z.string().nullable(),
  channelKind: campaignChannelKindSchema.nullable(),
  stats: campaignStatsSchema,
  /** Divisão automática em dias (só canais QR). */
  dayPlan: z.array(z.object({ date: z.iso.date(), count: z.number().int() })),
  pauseReason: campaignPauseReasonSchema.nullable(),
  pauseDetail: z.string().nullable(),
  nextSendAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type Campaign = z.infer<typeof campaignSchema>;

export const campaignRecipientStatusSchema = z.enum([
  "queued",
  "sent",
  "delivered",
  "read",
  "replied",
  "failed",
  "opted_out",
  "no_whatsapp",
]);
export type CampaignRecipientStatus = z.infer<typeof campaignRecipientStatusSchema>;

/** Registro por envio (§5.7 item 6). Alimenta Histórico e Rejeitados. */
export const campaignRecipientSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  campaignName: z.string(),
  contactName: z.string(),
  phoneMasked: z.string(),
  status: campaignRecipientStatusSchema,
  /** Número da variação usada (1…n), quando houve envio. */
  variationNumber: z.number().int().nullable(),
  intervalSeconds: z.number().int().nullable(),
  at: z.iso.datetime().nullable(),
});
export type CampaignRecipient = z.infer<typeof campaignRecipientSchema>;

export const REJECTED_STATUSES = ["opted_out", "no_whatsapp", "failed"] as const satisfies readonly CampaignRecipientStatus[];

export const campaignTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: campaignMessageTypeSchema,
  body: z.string(),
  buttons: z.array(z.string()),
  /** "meta": modelo da API oficial, com status de aprovação. */
  source: z.enum(["internal", "meta"]),
  metaStatus: z.enum(["approved", "pending", "rejected"]).nullable(),
  updatedAt: z.iso.datetime(),
});
export type CampaignTemplate = z.infer<typeof campaignTemplateSchema>;

export const campaignTermsSchema = z.object({
  accepted: z.boolean(),
  acceptedAt: z.iso.datetime().nullable(),
  acceptedBy: z.string().nullable(),
  version: z.string(),
});
export type CampaignTerms = z.infer<typeof campaignTermsSchema>;

// ---------- entradas ----------

export const campaignDraftInputSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome para a campanha.").max(80),
  audienceId: z.string().nullable(),
  message: campaignMessageSchema,
  variationMode: variationModeSchema,
  variations: z.array(messageVariationSchema).max(MAX_VARIATIONS),
  variationsBase: z.string().nullable(),
  sending: campaignSendingSchema,
});
export type CampaignDraftInput = z.infer<typeof campaignDraftInputSchema>;

export const generateVariationsInputSchema = z.object({
  base: z.string().trim().min(10, "Escreva a mensagem base antes de gerar variações.").max(1024),
  optOutLine: z.string().min(1),
  count: z.number().int().min(MIN_VARIATIONS).max(MAX_VARIATIONS),
});
export type GenerateVariationsInput = z.infer<typeof generateVariationsInputSchema>;

export const campaignListTabSchema = z.enum(["campanhas", "historico", "rejeitados", "modelos"]);
export type CampaignListTab = z.infer<typeof campaignListTabSchema>;

export const campaignDetailTabSchema = z.enum(["resumo", "envios", "rejeitados"]);
export type CampaignDetailTab = z.infer<typeof campaignDetailTabSchema>;

// ---------- regras puras compartilhadas com o worker ----------

export const SAFE_LIMITS = { dailyMax: 50, hourlyMax: 15, warmup: [{ untilDay: 3, daily: 10 }, { untilDay: 7, daily: 25 }] } as const;

/** Limite diário pelo aquecimento do número: dias 1–3 → 10, 4–7 → 25, depois 50. */
export function warmupDailyLimit(numberAgeDays: number) {
  for (const step of SAFE_LIMITS.warmup) if (numberAgeDays <= step.untilDay) return step.daily;
  return SAFE_LIMITS.dailyMax;
}

/** Divide o público em dias: 64 pessoas com limite 50 → [50, 14]. `sentToday` reduz o primeiro dia. */
export function splitIntoDays(recipients: number, dailyLimit: number, sentToday = 0) {
  if (recipients <= 0 || dailyLimit <= 0) return [];
  const days: number[] = [];
  let left = recipients;
  let firstDay = Math.max(0, dailyLimit - sentToday);
  if (firstDay === 0) firstDay = dailyLimit; // hoje já esgotado: começa amanhã com o limite cheio
  days.push(Math.min(left, firstDay));
  left -= days[0] ?? 0;
  while (left > 0) {
    const today = Math.min(left, dailyLimit);
    days.push(today);
    left -= today;
  }
  return days;
}

function addDays(isoDate: string, days: number) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Datas de cada dia de envio a partir de `startDate` (AAAA-MM-DD), pulando domingos se pedido. */
export function scheduleDays(counts: readonly number[], startDate: string, skipSundays: boolean) {
  const plan: { date: string; count: number }[] = [];
  let date = startDate;
  for (const count of counts) {
    while (skipSundays && new Date(`${date}T12:00:00Z`).getUTCDay() === 0) date = addDays(date, 1);
    plan.push({ date, count });
    date = addDays(date, 1);
  }
  return plan;
}

/** Duração estimada de um dia de envio: intervalo médio, pausas longas a cada ~11 e teto por hora. */
export function estimateDaySeconds(count: number, minSeconds: number, maxSeconds: number, hourlyLimit: number) {
  if (count <= 0) return 0;
  const byInterval = count * ((minSeconds + maxSeconds) / 2) + Math.floor(count / 11.5) * 600;
  const byHourly = hourlyLimit > 0 ? ((count - 1) / hourlyLimit) * 3600 : 0;
  return Math.round(Math.max(byInterval, byHourly));
}

const variableRe = /\{[a-z_]+\}/g;
const linkRe = /https?:\/\/\S+|www\.\S+/gi;
const numberRe = /R\$\s?\d[\d.,]*|\d+[\d.,:h%]*/gi;

function tokens(text: string, re: RegExp) {
  return new Set((text.match(re) ?? []).map((t) => t.toLowerCase()));
}

function words(text: string) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}{}_ ]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Similaridade de Jaccard entre os conjuntos de palavras (0 a 1). */
export function textSimilarity(a: string, b: string) {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size && !wb.size) return 1;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / (wa.size + wb.size - common);
}

/**
 * Validador automático de variações (§5.7 item 4). Código, não IA.
 * `others` são as demais variações do banco, para barrar as parecidas demais.
 */
export function validateVariation(base: string, optOutLine: string, text: string, others: readonly string[] = []) {
  const issues: VariationIssue[] = [];
  const vars = tokens(text, variableRe);
  for (const v of tokens(base, variableRe)) if (!vars.has(v)) issues.push("missing_variable");
  const links = tokens(text, linkRe);
  for (const l of tokens(base, linkRe)) if (!links.has(l)) issues.push("missing_link");
  if (!text.trim().endsWith(optOutLine.trim())) issues.push("missing_opt_out");
  const baseNumbers = tokens(`${base} ${optOutLine}`, numberRe);
  const baseLinks = tokens(base, linkRe);
  const extraNumber = [...tokens(text, numberRe)].some((n) => !baseNumbers.has(n));
  const extraLink = [...links].some((l) => !baseLinks.has(l));
  if (extraNumber || extraLink) issues.push("unknown_number_or_link");
  const body = text.replace(optOutLine, "");
  // tamanho: ±40% da base, com folga mínima de 40 caracteres para mensagens curtas
  const lengthDiff = Math.abs(body.trim().length - base.trim().length);
  if (lengthDiff > Math.max(base.trim().length * 0.4, 40) || textSimilarity(base, body) < 0.12) issues.push("too_different");
  if (others.some((o) => o !== text && textSimilarity(o, text) > 0.95) || body.trim() === base.trim()) {
    issues.push("too_similar");
  }
  return [...new Set(issues)];
}

/** Troca as variáveis por valores de exemplo (prévia no celular). */
export function fillVariables(text: string, values: Record<string, string>) {
  return text.replace(variableRe, (v) => values[v] ?? v);
}
