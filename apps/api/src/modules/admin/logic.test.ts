import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  companyStatusOf,
  dateInPlatformTz,
  daysPastDue,
  diffRecords,
  endOfDueDate,
  formatDay,
  formatPrice,
  slugify,
  storedStatusFor,
  validateReason,
} from "./logic";

const today = "2026-10-26";
const status = (dueDate: string, extra: Partial<{ enabled: boolean; onTrial: boolean }> = {}) =>
  companyStatusOf({ enabled: true, onTrial: false, dueDate, today, ...extra });

describe("status da empresa", () => {
  it("em dia: vence hoje ou no futuro", () => {
    expect(status("2026-10-26")).toBe("active");
    expect(status("2026-11-12")).toBe("active");
  });

  it("em teste enquanto o teste não acabou", () => {
    expect(status("2026-10-29", { onTrial: true })).toBe("trial");
    expect(status("2026-10-26", { onTrial: true })).toBe("trial");
  });

  it("vencida: 1 dia de tolerância ainda usa tudo", () => {
    expect(status("2026-10-25")).toBe("overdue");
  });

  it("expirada (suspensa): a partir do 2º dia de atraso", () => {
    expect(status("2026-10-24")).toBe("expired"); // 2
    expect(status("2026-10-15")).toBe("expired");
    expect(status("2026-09-25")).toBe("expired");
  });

  it("teste vencido tem a mesma tolerância de 1 dia e depois expira", () => {
    expect(status("2026-10-25", { onTrial: true })).toBe("overdue");
    expect(status("2026-10-24", { onTrial: true })).toBe("expired");
  });

  it("desativada vence qualquer outra situação", () => {
    expect(status("2026-11-12", { enabled: false })).toBe("disabled");
    expect(status("2026-01-01", { enabled: false, onTrial: true })).toBe("disabled");
  });

  it("dias de atraso só contam depois do vencimento", () => {
    expect(daysPastDue("2026-10-26", today)).toBeNull();
    expect(daysPastDue("2026-10-25", today)).toBe(1);
    expect(daysPastDue("2026-11-01", today)).toBeNull();
  });

  it("valor guardado em subscriptions.status respeita o check do banco", () => {
    const allowed = new Set(["trial", "active", "past_due", "expired", "canceled"]);
    for (const s of ["active", "trial", "overdue", "past_due", "expired", "disabled"] as const) {
      expect(allowed.has(storedStatusFor(s))).toBe(true);
    }
    expect(storedStatusFor("disabled")).toBe("canceled");
    expect(storedStatusFor("overdue")).toBe("past_due");
  });
});

describe("datas no fuso da plataforma", () => {
  it("23h30 em São Paulo ainda é o mesmo dia (UTC já virou)", () => {
    expect(dateInPlatformTz(new Date("2026-10-27T02:30:00Z"))).toBe("2026-10-26");
    expect(dateInPlatformTz(new Date("2026-10-27T03:00:00Z"))).toBe("2026-10-27");
  });

  it("fim do dia do vencimento é 23:59:59 de Brasília", () => {
    expect(endOfDueDate("2026-11-12").toISOString()).toBe("2026-11-13T02:59:59.000Z");
    expect(dateInPlatformTz(endOfDueDate("2026-11-12"))).toBe("2026-11-12");
  });

  it("aritmética de datas e formatação", () => {
    expect(addDaysIso("2026-10-30", 3)).toBe("2026-11-02");
    expect(formatDay("2026-11-12")).toBe("12/11/2026");
    expect(formatPrice(null)).toBe("R$ [VALOR]");
    expect(formatPrice(123456)).toBe("R$ 1.234,56");
  });
});

describe("motivo obrigatório da auditoria", () => {
  it("recusa vazio, só espaços e menos de 10 caracteres", () => {
    expect(validateReason("").ok).toBe(false);
    expect(validateReason("          ").ok).toBe(false);
    expect(validateReason("curto demais").ok).toBe(true); // 12 caracteres
    expect(validateReason("123456789").ok).toBe(false);
    expect(validateReason(undefined).ok).toBe(false);
    expect(validateReason(42).ok).toBe(false);
  });

  it("conta caracteres úteis (espaços nas pontas não valem)", () => {
    expect(validateReason("   123456789   ").ok).toBe(false);
    const ok = validateReason("   1234567890   ");
    expect(ok).toEqual({ ok: true, reason: "1234567890" });
  });

  it("recusa motivo gigante", () => {
    expect(validateReason("x".repeat(501)).ok).toBe(false);
    expect(validateReason("x".repeat(500)).ok).toBe(true);
  });
});

describe("diff antes→depois", () => {
  it("lista só o que mudou", () => {
    expect(diffRecords({ Plano: "Pro", Canais: "5" }, { Plano: "Escala", Canais: "5" })).toEqual([
      { field: "Plano", from: "Pro", to: "Escala" },
    ]);
  });
  it("campo novo entra com from null", () => {
    expect(diffRecords({}, { Nome: "X" })).toEqual([{ field: "Nome", from: null, to: "X" }]);
  });
  it("slug de plano", () => {
    expect(slugify("Lançamento 2025!")).toBe("lancamento-2025");
  });
});
