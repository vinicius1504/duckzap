import type { AppointmentStatus, CalendarSync } from "@duckzap/contracts/appointments";
import type { ChipTone } from "@duckzap/ui/components/chip";

// O contrato não carrega nada visual: aqui o status vira texto e tom.

export const statusView: Record<AppointmentStatus, { label: string; tone: ChipTone; block: string }> = {
  pending: { label: "Pendente", tone: "warn", block: "bg-warn-bg text-warn" },
  confirmed: { label: "Confirmado", tone: "ok", block: "bg-ok-bg text-ok" },
  reschedule: { label: "A remarcar", tone: "err", block: "bg-err-bg text-err" },
  done: { label: "Concluído", tone: "neutral", block: "bg-surface-2 text-ink-2" },
  canceled: { label: "Cancelado", tone: "neutral", block: "bg-surface-2 text-ink-2 line-through" },
};

/** Próximas ações possíveis a partir de cada status. */
export const statusActions: Record<AppointmentStatus, { to: AppointmentStatus; label: string; primary?: boolean }[]> = {
  pending: [
    { to: "confirmed", label: "Confirmar", primary: true },
    { to: "reschedule", label: "Marcar para remarcar" },
    { to: "canceled", label: "Cancelar" },
  ],
  confirmed: [
    { to: "done", label: "Concluir", primary: true },
    { to: "reschedule", label: "Marcar para remarcar" },
    { to: "canceled", label: "Cancelar" },
  ],
  reschedule: [
    { to: "confirmed", label: "Confirmar mesmo horário" },
    { to: "canceled", label: "Cancelar" },
  ],
  done: [{ to: "confirmed", label: "Reabrir" }],
  canceled: [{ to: "pending", label: "Reativar" }],
};

export const syncView: Record<CalendarSync["status"], { label: string; tone: ChipTone }> = {
  synced: { label: "Sincronizado", tone: "ok" },
  syncing: { label: "Sincronizando…", tone: "info" },
  error: { label: "Com erro", tone: "err" },
  disconnected: { label: "Desconectado", tone: "neutral" },
};

export const sourceLabel = { manual: "Marcado por", ai_agent: "Marcado pelo agente", google: "Veio do Google Calendar" } as const;
