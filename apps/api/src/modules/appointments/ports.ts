// Porta do Google Calendar. Nesta fase não há OAuth: o adaptador em memória "sincroniza" sem falar com o Google.
// A integração real (OAuth + worker) implementa esta interface e é injetada em `appointmentsRoutes(deps, ports)`.

export type CalendarSyncOutcome = { ok: true; pushed: number } | { ok: false; message: string };

export interface CalendarPort {
  /** Empurra/puxa os eventos da empresa. Pode demorar: roda fora da transação do banco. */
  sync(organizationId: string): Promise<CalendarSyncOutcome>;
}

export type AppointmentsPorts = { calendar: CalendarPort };

/** Adaptador sem efeito externo: sempre "funciona". Marca como sincronizado sem enviar nada ao Google. */
export function createNoopCalendarPort(): CalendarPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sync: async (organizationId) => {
      calls.push(organizationId);
      return { ok: true, pushed: 0 };
    },
  };
}
