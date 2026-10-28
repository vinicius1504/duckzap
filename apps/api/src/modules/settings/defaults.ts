import type { BusinessHours, ServiceSettings } from "@duckzap/contracts/settings";

/** Horário comercial padrão (segunda a sexta 08–18, sábado 08–12, domingo fechado), na ordem que a tela usa. */
export function defaultBusinessHours(): BusinessHours {
  return [
    { day: 1, open: true, start: "08:00", end: "18:00" },
    { day: 2, open: true, start: "08:00", end: "18:00" },
    { day: 3, open: true, start: "08:00", end: "18:00" },
    { day: 4, open: true, start: "08:00", end: "18:00" },
    { day: 5, open: true, start: "08:00", end: "18:00" },
    { day: 6, open: true, start: "08:00", end: "12:00" },
    { day: 0, open: false, start: "08:00", end: "12:00" },
  ];
}

export function defaultServiceSettings(): ServiceSettings {
  return {
    followUp: { firstReminderHours: 2, secondReminderHours: 24, message: "Oi, {nome}! Ainda posso te ajudar com algo?" },
    inactivityClose: { enabled: true, days: 3 },
  };
}

/** Fuso válido para o `Intl` (evita gravar texto qualquer em `organization.time_zone`). */
export function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
