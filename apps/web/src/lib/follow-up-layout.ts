// Prévia de layout do "Follow-up automático" (cartão no topo da página Agentes). Só lógica da tela: nada é salvo nem enviado.
// O follow-up é um agente fixo do sistema: ele lê a conversa e escreve cada mensagem; a empresa só define QUANDO (etapas de
// tempo de espera) e algumas regras. Por isso uma etapa é só um tempo (número + unidade), sem texto de mensagem.

export type WaitUnit = "minutes" | "hours" | "days";

export type WaitStep = { id: string; amount: number; unit: WaitUnit };

export const MAX_FOLLOW_UP_STEPS = 5;
export const FOLLOW_UP_EXTRA_MAX = 500;

export const WAIT_UNITS: readonly { value: WaitUnit; label: string; labelPlural: string }[] = [
  { value: "minutes", label: "minuto", labelPlural: "minutos" },
  { value: "hours", label: "hora", labelPlural: "horas" },
  { value: "days", label: "dia", labelPlural: "dias" },
];

const MINUTES_PER_UNIT: Record<WaitUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** Limites da espera de uma etapa, por unidade (de 1 até 3 horas, 72 horas ou 30 dias). */
export const WAIT_LIMITS: Record<WaitUnit, { min: number; max: number }> = {
  minutes: { min: 1, max: 180 },
  hours: { min: 1, max: 72 },
  days: { min: 1, max: 30 },
};

export type FollowUpLayoutState = {
  enabled: boolean;
  steps: WaitStep[];
  respectBusinessHours: boolean;
  stopOnReply: boolean;
  extraInstructions: string;
};

let counter = 0;
export function newStepId(): string {
  counter += 1;
  return `wait_${counter}`;
}

export function toMinutes(step: Pick<WaitStep, "amount" | "unit">): number {
  return step.amount * MINUTES_PER_UNIT[step.unit];
}

/** Número inteiro dentro dos limites da unidade (texto vazio ou inválido vira o mínimo). */
export function clampAmount(amount: number, unit: WaitUnit): number {
  const { min, max } = WAIT_LIMITS[unit];
  if (!Number.isFinite(amount)) return min;
  return Math.min(max, Math.max(min, Math.round(amount)));
}

/** "Após 30 min", "Após 2 h", "Após 24 h", "Após 1 dia", "Após 3 dias". */
export function stepLabel(step: Pick<WaitStep, "amount" | "unit">): string {
  if (step.unit === "minutes") return `Após ${step.amount} min`;
  if (step.unit === "hours") return `Após ${step.amount} h`;
  return `Após ${step.amount} ${step.amount === 1 ? "dia" : "dias"}`;
}

/** Minutos → o par (número, unidade) mais natural: 120 → 2 h, 4320 → 3 dias, 90 → 90 min. Acima do limite, usa o limite. */
export function fromMinutes(totalMinutes: number): { amount: number; unit: WaitUnit } {
  const minutes = Math.max(1, Math.round(totalMinutes));
  if (minutes % 1440 === 0 && minutes / 1440 <= WAIT_LIMITS.days.max) return { amount: minutes / 1440, unit: "days" };
  if (minutes % 60 === 0 && minutes / 60 <= WAIT_LIMITS.hours.max) return { amount: minutes / 60, unit: "hours" };
  if (minutes <= WAIT_LIMITS.minutes.max) return { amount: minutes, unit: "minutes" };
  if (minutes < 1440 * 1.5 && minutes / 60 <= WAIT_LIMITS.hours.max) return { amount: Math.round(minutes / 60), unit: "hours" };
  return { amount: Math.min(WAIT_LIMITS.days.max, Math.max(1, Math.round(minutes / 1440))), unit: "days" };
}

export function defaultFollowUpLayout(): FollowUpLayoutState {
  return {
    enabled: false,
    steps: [
      { id: newStepId(), amount: 2, unit: "hours" },
      { id: newStepId(), amount: 1, unit: "days" },
    ],
    respectBusinessHours: true,
    stopOnReply: true,
    extraInstructions: "",
  };
}

export function canAddStep(steps: readonly WaitStep[]): boolean {
  return steps.length < MAX_FOLLOW_UP_STEPS;
}

/** Acrescenta uma etapa no fim, esperando o dobro da anterior (2 h se não houver). No limite, devolve a lista como está. */
export function addStep(steps: readonly WaitStep[]): WaitStep[] {
  if (!canAddStep(steps)) return [...steps];
  const last = steps[steps.length - 1];
  const next = last ? fromMinutes(toMinutes(last) * 2) : { amount: 2, unit: "hours" as const };
  return [...steps, { id: newStepId(), ...next }];
}

export function removeStep(steps: readonly WaitStep[], id: string): WaitStep[] {
  return steps.filter((step) => step.id !== id);
}

/** Sobe (`-1`) ou desce (`1`) uma etapa. Nas pontas não faz nada. */
export function moveStep(steps: readonly WaitStep[], id: string, direction: -1 | 1): WaitStep[] {
  const index = steps.findIndex((step) => step.id === id);
  const target = index + direction;
  const item = steps[index];
  const other = steps[target];
  if (index < 0 || item === undefined || other === undefined) return [...steps];
  const next = [...steps];
  next[index] = other;
  next[target] = item;
  return next;
}

/** Troca o número da etapa (sempre dentro dos limites da unidade). */
export function setStepAmount(steps: readonly WaitStep[], id: string, amount: number): WaitStep[] {
  return steps.map((step) => (step.id === id ? { ...step, amount: clampAmount(amount, step.unit) } : step));
}

/** Troca a unidade da etapa, ajustando o número ao limite da nova unidade. */
export function setStepUnit(steps: readonly WaitStep[], id: string, unit: WaitUnit): WaitStep[] {
  return steps.map((step) => (step.id === id ? { ...step, unit, amount: clampAmount(step.amount, unit) } : step));
}

/** As esperas estão em ordem crescente? (A tela só avisa; reordenar é livre.) */
export function isAscending(steps: readonly WaitStep[]): boolean {
  return steps.every((step, i) => i === 0 || toMinutes(step) >= toMinutes(steps[i - 1] as WaitStep));
}

/** Resumo do cartão fechado. */
export function followUpLayoutSummary(state: FollowUpLayoutState): string {
  const steps = state.steps.length;
  const when = steps === 0 ? "sem etapas" : state.steps.map(stepLabel).join(", ");
  return `${state.enabled ? "Ligado na prévia" : "Desligado na prévia"} · ${when}`;
}

/** Exemplos fictícios do que o agente de follow-up escreveria. Ilustração: nada disso é enviado. */
export const FOLLOW_UP_EXAMPLES: readonly string[] = [
  "Oi, Marina! Passando para saber se ficou alguma dúvida sobre o orçamento que conversamos. Se quiser, posso ajustar a proposta para caber melhor no que você precisa.",
  "Olá, Carlos! Vi que combinamos de retomar a conversa sobre o horário de quinta. Ainda faz sentido para você?",
];
