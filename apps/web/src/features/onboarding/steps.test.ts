import type { OnboardingDraft } from "@duckzap/contracts/onboarding";
import type { Session } from "@duckzap/contracts/session";
import { describe, expect, it } from "vitest";
import { furthestStep, needsOnboarding, resolveOnboardingRoute, stepOrder, wizardSteps } from "./steps";

const company = {
  companyName: "Casa Alvorada",
  businessHours: [],
  welcomeMessage: "",
} as unknown as NonNullable<OnboardingDraft["company"]>;

type Draft = Pick<OnboardingDraft, "security" | "company" | "whatsapp" | "completedAt" | "role">;
const openSecurity: Draft["security"] = { twoFactorEnabled: false, method: null, skippedAt: null };
const skippedSecurity: Draft["security"] = { twoFactorEnabled: false, method: null, skippedAt: "2026-11-19T09:00:00.000Z" };
// conta nova que já resolveu o passo opcional de segurança (pulou)
const base: Draft = { security: skippedSecurity, company: null, whatsapp: null, completedAt: null, role: null };
const connected: Draft["whatsapp"] = { method: "qr_code", status: "connected", phone: "+5511999990000" };
const skipped: Draft["whatsapp"] = { method: "qr_code", status: "skipped", phone: null };

describe("passos do cadastro", () => {
  it("ordem e rótulos vêm da mesma lista (o cabeçalho acompanha um passo novo)", () => {
    expect(stepOrder).toEqual(["seguranca", "empresa", "whatsapp", "agente", "pronto"]);
    expect(wizardSteps).toEqual(["Segurança", "Empresa", "WhatsApp", "Primeiro agente"]);
  });

  it("segurança (opcional) vem logo depois de criar a conta: feita com o 2FA ativo, por qualquer método, ou pulada", () => {
    expect(furthestStep({ ...base, security: openSecurity })).toBe("seguranca");
    expect(furthestStep({ ...base, security: skippedSecurity })).toBe("empresa");
    for (const method of ["app", "email"] as const) {
      expect(furthestStep({ ...base, security: { twoFactorEnabled: true, method, skippedAt: null } })).toBe("empresa");
    }
    // em aberto, não deixa pular para a empresa pela URL; pode sempre voltar ao passo depois de resolvido
    expect(resolveOnboardingRoute({ ...base, security: openSecurity }, "empresa")).toEqual({ kind: "step", step: "seguranca" });
    expect(resolveOnboardingRoute(base, "seguranca")).toEqual({ kind: "step", step: "seguranca" });
    // quem já passou da empresa antes de o passo existir e não resolveu: volta a ele uma vez (dá para pular)
    expect(furthestStep({ ...base, security: openSecurity, company })).toBe("seguranca");
  });

  it("furthestStep segue o que está no banco", () => {
    expect(furthestStep(base)).toBe("empresa");
    expect(furthestStep({ ...base, company })).toBe("whatsapp");
    expect(furthestStep({ ...base, company, whatsapp: connected })).toBe("agente");
    expect(furthestStep({ ...base, company, whatsapp: skipped })).toBe("agente");
    expect(furthestStep({ ...base, company, whatsapp: null, completedAt: "2026-11-19T10:00:00.000Z" })).toBe("pronto");
  });
});

describe("resolveOnboardingRoute", () => {
  const owner: Draft = { ...base, company, role: "owner" };

  it("conta sem empresa: passo Empresa, mesmo pedindo um adiante", () => {
    expect(resolveOnboardingRoute(base, undefined)).toEqual({ kind: "step", step: "empresa" });
    expect(resolveOnboardingRoute(base, "agente")).toEqual({ kind: "step", step: "empresa" });
    expect(resolveOnboardingRoute(base, "pronto")).toEqual({ kind: "step", step: "empresa" });
  });

  it("dono no meio: retoma o passo certo sem cookie, e pode voltar a um anterior", () => {
    expect(resolveOnboardingRoute(owner, undefined)).toEqual({ kind: "step", step: "whatsapp" });
    expect(resolveOnboardingRoute(owner, "lixo")).toEqual({ kind: "step", step: "whatsapp" });
    expect(resolveOnboardingRoute({ ...owner, whatsapp: skipped }, "empresa")).toEqual({ kind: "step", step: "empresa" });
    expect(resolveOnboardingRoute({ ...owner, whatsapp: skipped }, "agente")).toEqual({ kind: "step", step: "agente" });
  });

  it("concluído: só a tela pronto; o resto vai para o app", () => {
    const done = { ...owner, completedAt: "2026-11-19T10:00:00.000Z" };
    expect(resolveOnboardingRoute(done, "pronto")).toEqual({ kind: "step", step: "pronto" });
    expect(resolveOnboardingRoute(done, undefined)).toEqual({ kind: "redirect", to: "/inicio" });
    expect(resolveOnboardingRoute(done, "empresa")).toEqual({ kind: "redirect", to: "/inicio" });
  });

  it("convidado (não é dono) nunca faz o cadastro, mesmo com a empresa em aberto", () => {
    for (const role of ["admin", "agent"] as const) {
      expect(resolveOnboardingRoute({ ...owner, role }, undefined)).toEqual({ kind: "redirect", to: "/inicio" });
    }
  });
});

describe("needsOnboarding", () => {
  const session = (role: Session["user"]["role"], onboardingCompleted: boolean) =>
    ({ user: { role }, organization: { onboardingCompleted } }) as Session;

  it("só o dono com o cadastro em aberto", () => {
    expect(needsOnboarding(session("owner", false))).toBe(true);
    expect(needsOnboarding(session("owner", true))).toBe(false);
    expect(needsOnboarding(session("admin", false))).toBe(false);
    expect(needsOnboarding(session("agent", false))).toBe(false);
  });
});
