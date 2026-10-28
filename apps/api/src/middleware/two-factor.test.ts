import type { Database } from "@duckzap/db";
import { describe, expect, it } from "vitest";
import type { AuthSession } from "../lib/context";
import { loadSecurityConfig } from "./security-config";
import { isTwoFactorExemptPath, mustSetUpTwoFactor, needsTwoFactor } from "./two-factor";

describe("2FA obrigatório para Proprietário/Administrador (§5.1)", () => {
  it("exige de owner e admin sem 2FA; não exige de atendente nem de quem já ativou", () => {
    expect(needsTwoFactor({ role: "owner", twoFactorEnabled: false, required: true })).toBe(true);
    expect(needsTwoFactor({ role: "admin", twoFactorEnabled: false, required: true })).toBe(true);
    expect(needsTwoFactor({ role: "agent", twoFactorEnabled: false, required: true })).toBe(false);
    expect(needsTwoFactor({ role: "owner", twoFactorEnabled: true, required: true })).toBe(false);
    expect(needsTwoFactor({ role: "owner", twoFactorEnabled: false, required: false })).toBe(false);
  });

  it("só /me, /onboarding e /account ficam abertos sem 2FA", () => {
    for (const path of ["/v1/me", "/v1/onboarding", "/v1/onboarding/company", "/v1/account/password"]) {
      expect(isTwoFactorExemptPath(path)).toBe(true);
    }
    for (const path of ["/v1/team/overview", "/v1/channels", "/v1/contacts", "/v1/settings/company", "/v1/meus-dados", "/v1/accounting"]) {
      expect(isTwoFactorExemptPath(path)).toBe(false);
    }
  });

  it("padrão: ligado em produção, desligado em dev/test; a variável manda", () => {
    expect(loadSecurityConfig({ NODE_ENV: "production" }).require2faForAdmins).toBe(true);
    expect(loadSecurityConfig({ NODE_ENV: "development" }).require2faForAdmins).toBe(false);
    expect(loadSecurityConfig({ NODE_ENV: "test" }).require2faForAdmins).toBe(false);
    expect(loadSecurityConfig({ NODE_ENV: "production", REQUIRE_2FA_FOR_ADMINS: "false" }).require2faForAdmins).toBe(false);
    expect(loadSecurityConfig({ NODE_ENV: "development", REQUIRE_2FA_FOR_ADMINS: "true" }).require2faForAdmins).toBe(true);
    expect(loadSecurityConfig({}).trustProxy).toBe(false);
  });

  // banco falso: devolve as filiações pedidas
  const dbWith = (rows: Array<{ role: string; organizationId: string }>) =>
    ({ select: () => ({ from: () => ({ where: async () => rows }) }) }) as unknown as Database;
  const authOf = (twoFactorEnabled: boolean) =>
    ({ user: { id: "u1", twoFactorEnabled }, session: { activeOrganizationId: "o1" } }) as unknown as AuthSession;

  it("mustSetUpTwoFactor olha o papel na empresa ativa", async () => {
    expect(await mustSetUpTwoFactor(dbWith([{ role: "owner", organizationId: "o1" }]), authOf(false), true)).toBe(true);
    expect(await mustSetUpTwoFactor(dbWith([{ role: "admin", organizationId: "o1" }]), authOf(false), true)).toBe(true);
    expect(await mustSetUpTwoFactor(dbWith([{ role: "member", organizationId: "o1" }]), authOf(false), true)).toBe(false);
    expect(await mustSetUpTwoFactor(dbWith([{ role: "owner", organizationId: "o1" }]), authOf(true), true)).toBe(false);
    expect(await mustSetUpTwoFactor(dbWith([{ role: "owner", organizationId: "o1" }]), authOf(false), false)).toBe(false);
    // sem empresa ainda (cadastro em andamento): não bloqueia
    expect(await mustSetUpTwoFactor(dbWith([]), authOf(false), true)).toBe(false);
  });
});
