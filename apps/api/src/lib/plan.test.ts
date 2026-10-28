import { effectiveSubscriptionStatus, isAccountSuspended, isSendingPausedStatus, type SubscriptionStatus } from "@duckzap/contracts/session";
import { describe, expect, it } from "vitest";
import { NO_PLAN, planFromRows, tokenLimitValue } from "./plan";

const at = (iso: string) => new Date(iso);
// vencimento: 10/03/2026 12:00 em Brasília (15:00Z). "Agora" varia em dias do fuso da plataforma.
const end = at("2026-03-10T15:00:00Z");
const day = (d: number, hour = 12) => at(`2026-03-${String(d).padStart(2, "0")}T${String(hour + 3).padStart(2, "0")}:00:00Z`);

type Row = { status: SubscriptionStatus; now: Date; disabledAt?: Date | null; expect: SubscriptionStatus; paused: boolean; label: string };

const table: Row[] = [
  { label: "ativa em dia", status: "active", now: day(5), expect: "active", paused: false },
  { label: "ativa no próprio dia do vencimento (não é atraso)", status: "active", now: at("2026-03-11T01:00:00Z"), expect: "active", paused: false },
  { label: "ativa 1 dia depois: tolerância, ainda usa tudo", status: "active", now: day(11, 8), expect: "past_due", paused: false },
  { label: "ativa 2 dias depois: suspensa", status: "active", now: day(12, 8), expect: "expired", paused: true },
  { label: "ativa vencida há muito: suspensa", status: "active", now: at("2026-05-20T15:00:00Z"), expect: "expired", paused: true },
  { label: "past_due guardado dentro da tolerância: ainda envia", status: "past_due", now: day(11, 8), expect: "past_due", paused: false },
  { label: "past_due guardado passada a tolerância: suspensa", status: "past_due", now: day(13), expect: "expired", paused: true },
  { label: "past_due guardado antes do vencimento: envia", status: "past_due", now: day(5), expect: "past_due", paused: false },
  { label: "teste em dia", status: "trial", now: day(5), expect: "trial", paused: false },
  { label: "teste 1 dia depois: tolerância", status: "trial", now: day(11, 8), expect: "past_due", paused: false },
  { label: "teste 2 dias depois: suspensa", status: "trial", now: day(12, 8), expect: "expired", paused: true },
  { label: "expirada guardada continua expirada", status: "expired", now: day(5), expect: "expired", paused: true },
  { label: "cancelada", status: "canceled", now: day(5), expect: "canceled", paused: true },
  { label: "desativada pelo admin (status ainda active)", status: "active", now: day(5), disabledAt: at("2026-03-01T00:00:00Z"), expect: "canceled", paused: true },
];

describe("effectiveSubscriptionStatus (mesma regra do Painel Admin)", () => {
  for (const row of table) {
    it(row.label, () => {
      const status = effectiveSubscriptionStatus({ status: row.status, currentPeriodEnd: end, disabledAt: row.disabledAt ?? null, now: row.now });
      expect(status).toBe(row.expect);
      expect(isSendingPausedStatus(status)).toBe(row.paused);
      expect(isAccountSuspended(status)).toBe(row.paused);
    });
  }

  it("conta dias no fuso da plataforma, não em UTC", () => {
    // 11/03 01:00 UTC ainda é 10/03 22:00 em Brasília: continua sendo o dia do vencimento
    expect(effectiveSubscriptionStatus({ status: "active", currentPeriodEnd: end, now: at("2026-03-11T01:00:00Z") })).toBe("active");
    // 11/03 03:00 UTC = 11/03 00:00 em Brasília: 1 dia de atraso
    expect(effectiveSubscriptionStatus({ status: "active", currentPeriodEnd: end, now: at("2026-03-11T03:00:00Z") })).toBe("past_due");
  });
});

describe("resolução de plano", () => {
  const plan = {
    slug: "clinica-premium",
    name: "Clínica Premium",
    maxChannels: 7,
    maxUsers: 12,
    maxAgents: null,
    monthlyTokenLimit: null,
    features: ["campaigns"],
    firstMonthPriceCents: null,
    recurringPriceCents: null,
    checkoutUrl: null,
    active: true,
    createdAt: at("2026-01-01T00:00:00Z"),
  };

  it("plano personalizado (slug livre) mantém o slug e os limites do banco", () => {
    const resolved = planFromRows(plan, undefined);
    expect(resolved).toMatchObject({ slug: "clinica-premium", limits: { channels: 7, users: 12, agents: null }, features: ["campaigns"] });
  });

  it("null em agentes/tokens significa ilimitado (não vira 1 nem o padrão do Essencial)", () => {
    const resolved = planFromRows(plan, undefined);
    expect(resolved.limits.agents).toBeNull();
    expect(resolved.monthlyTokenLimit).toBeNull();
    expect(tokenLimitValue(resolved)).toBe(Number.MAX_SAFE_INTEGER);
    expect(tokenLimitValue({ monthlyTokenLimit: 0 })).toBe(0);
  });

  it("sem plano: nada é liberado", () => {
    expect(planFromRows(undefined, undefined)).toEqual(NO_PLAN);
    expect(NO_PLAN.limits).toEqual({ channels: 0, users: 0, agents: 0 });
  });

  it("o status efetivo acompanha o vencimento da assinatura", () => {
    const subscription = {
      id: "s1",
      organizationId: "org",
      planSlug: "clinica-premium",
      status: "active",
      currentPeriodEnd: end,
      createdAt: end,
      updatedAt: end,
      onTrial: false,
      cycle: "monthly",
      disabledAt: null,
      gateway: null,
      gatewayReference: null,
    };
    expect(planFromRows(plan, subscription, day(11, 8)).status).toBe("past_due");
    expect(planFromRows(plan, subscription, day(25)).status).toBe("expired");
  });
});
