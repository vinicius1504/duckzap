import type {
  ConsentStatus,
  ContactEvent,
  ContactFilter,
  ContactOrigin,
  ImportField,
  InviteIneligibleReason,
  Tag,
  TagColor,
} from "@duckzap/contracts/contacts";
import type { ChipTone } from "@duckzap/ui/components/chip";
import type { IconName } from "@duckzap/ui/components/icon";

// O contrato não carrega nada visual: aqui o domínio vira texto e tom de chip.

export const consentView: Record<ConsentStatus | "none", { label: string; short: string; tone: ChipTone }> = {
  granted: { label: "Aceita receber", short: "Aceita", tone: "ok" },
  pending: { label: "Convite enviado, sem resposta", short: "Aguardando", tone: "warn" },
  denied: { label: "Não aceita receber", short: "Recusou", tone: "err" },
  expired: { label: "Convite expirou sem resposta", short: "Expirou", tone: "neutral" },
  none: { label: "Sem opt-in (nunca convidado)", short: "Sem opt-in", tone: "neutral" },
};

export const consentMethodLabel = {
  invite: "Convite de consentimento",
  conversation: "Na própria conversa",
  form: "Ficha ou formulário",
} as const;

export const originLabel: Record<ContactOrigin, string> = {
  customer: "Já é cliente",
  service: "Deixou o número em atendimento",
  form: "Formulário",
  walk_in: "Balcão / recepção",
  event: "Evento",
  referral: "Indicação",
  inbound: "Mandou mensagem primeiro",
};

export const ineligibleLabel: Record<InviteIneligibleReason, string> = {
  already_invited: "já recebeu o convite (é uma vez só)",
  has_consent: "já aceitou ou recusou",
  no_origin: "sem origem registrada",
  inbound: "mandou mensagem primeiro (o agente pergunta na conversa)",
  no_phone: "sem telefone",
};

export const importFieldLabel: Record<ImportField, string> = {
  name: "Nome",
  phone: "Telefone (WhatsApp)",
  email: "E-mail",
  birthDate: "Nascimento",
  note: "Observação",
  ignore: "Não importar",
};

export const eventIcon: Record<ContactEvent["kind"], IconName> = {
  conversation: "chat",
  appointment: "calendar",
  campaign: "send",
  consent: "shield",
  tag: "tag",
  import: "upload",
  created: "user",
};

/** Cor da etiqueta → amostra (só tokens). */
export const tagSwatch: Record<TagColor, string> = {
  ink: "bg-ink",
  duck: "bg-duck",
  slate: "bg-ink-2",
  ok: "bg-ok",
  info: "bg-info",
  warn: "bg-warn",
  err: "bg-err",
};

export const tagColorLabel: Record<TagColor, string> = {
  ink: "Grafite",
  duck: "Amarelo",
  slate: "Cinza",
  ok: "Verde",
  info: "Azul",
  warn: "Âmbar",
  err: "Vermelho",
};

export function describeFilter(filter: ContactFilter | null, tags: readonly Tag[]) {
  if (!filter) return "";
  const parts: string[] = [];
  if (filter.q) parts.push(`busca “${filter.q}”`);
  if (filter.tagId) parts.push(`etiqueta ${tags.find((t) => t.id === filter.tagId)?.name ?? "removida"}`);
  if (filter.isCustomer !== undefined) parts.push(filter.isCustomer ? "é cliente" : "ainda não é cliente");
  if (filter.consent) parts.push(consentView[filter.consent].short.toLowerCase());
  if (filter.createdWithinDays) parts.push(`criado nos últimos ${filter.createdWithinDays} dias`);
  if (filter.inactiveDays) parts.push(`sem conversa há ${filter.inactiveDays} dias`);
  if (filter.birthMonth) {
    const month = new Intl.DateTimeFormat("pt-BR", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, filter.birthMonth - 1, 15)));
    parts.push(`nascimento em ${month}`);
  }
  return parts.length ? `Filtro: ${parts.join(" · ")}` : "Filtro: todos os clientes";
}
