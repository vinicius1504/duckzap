import { describe, expect, it } from "vitest";
import {
  canAssignRole,
  canManageMember,
  checkDeactivate,
  checkReactivate,
  checkRoleChange,
  fromBetterAuthRole,
  isOverUserLimit,
  toBetterAuthRole,
} from "./rules";

describe("regras de papel da Equipe", () => {
  it("só o proprietário cria proprietários", () => {
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(canAssignRole("admin", "owner")).toBe(false);
    expect(canAssignRole("admin", "admin")).toBe(true);
    expect(canAssignRole("admin", "agent")).toBe(true);
    expect(canAssignRole("agent", "agent")).toBe(false);
  });

  it("só o proprietário mexe em administradores e proprietários", () => {
    expect(canManageMember("owner", { role: "owner" })).toBe(true);
    expect(canManageMember("owner", { role: "admin" })).toBe(true);
    expect(canManageMember("admin", { role: "agent" })).toBe(true);
    expect(canManageMember("admin", { role: "admin" })).toBe(false);
    expect(canManageMember("admin", { role: "owner" })).toBe(false);
    expect(canManageMember("agent", { role: "agent" })).toBe(false);
  });

  it("traduz o papel do Better Auth (member = Atendente)", () => {
    expect(toBetterAuthRole("agent")).toBe("member");
    expect(toBetterAuthRole("admin")).toBe("admin");
    expect(fromBetterAuthRole("member")).toBe("agent");
    expect(fromBetterAuthRole("owner")).toBe("owner");
    expect(fromBetterAuthRole("qualquer")).toBe("agent");
  });

  describe("mudança de papel", () => {
    const target = { id: "u1", role: "admin" as const };
    it("sem mudança não há violação", () => {
      expect(checkRoleChange({ actor: "agent", target, newRole: "admin", activeOwnerCount: 1 })).toBeNull();
    });
    it("administrador não muda papel de administrador nem promove a proprietário", () => {
      expect(checkRoleChange({ actor: "admin", target, newRole: "agent", activeOwnerCount: 1 })?.code).toBe("forbidden");
      expect(checkRoleChange({ actor: "admin", target: { id: "u2", role: "agent" }, newRole: "owner", activeOwnerCount: 1 })?.code).toBe(
        "forbidden",
      );
    });
    it("administrador promove atendente a administrador", () => {
      expect(checkRoleChange({ actor: "admin", target: { id: "u2", role: "agent" }, newRole: "admin", activeOwnerCount: 1 })).toBeNull();
    });
    it("o último proprietário ativo não pode ser rebaixado", () => {
      const owner = { id: "o1", role: "owner" as const };
      expect(checkRoleChange({ actor: "owner", target: owner, newRole: "admin", activeOwnerCount: 1 })?.code).toBe("last_owner");
      expect(checkRoleChange({ actor: "owner", target: owner, newRole: "admin", activeOwnerCount: 2 })).toBeNull();
    });
  });

  describe("inativar", () => {
    it("ninguém inativa a si mesmo", () => {
      expect(checkDeactivate({ actor: "owner", actorId: "o1", target: { id: "o1", role: "owner" }, activeOwnerCount: 2 })?.code).toBe("self");
    });
    it("administrador não inativa administrador/proprietário", () => {
      expect(checkDeactivate({ actor: "admin", actorId: "a1", target: { id: "a2", role: "admin" }, activeOwnerCount: 1 })?.code).toBe(
        "forbidden",
      );
      expect(checkDeactivate({ actor: "admin", actorId: "a1", target: { id: "o1", role: "owner" }, activeOwnerCount: 1 })?.code).toBe(
        "forbidden",
      );
    });
    it("o último proprietário ativo não pode ser inativado", () => {
      expect(checkDeactivate({ actor: "owner", actorId: "o2", target: { id: "o1", role: "owner" }, activeOwnerCount: 1 })?.code).toBe(
        "last_owner",
      );
      expect(checkDeactivate({ actor: "owner", actorId: "o2", target: { id: "o1", role: "owner" }, activeOwnerCount: 2 })).toBeNull();
    });
    it("reativar segue a mesma regra de quem pode mexer", () => {
      expect(checkReactivate({ actor: "admin", actorId: "a1", target: { id: "a2", role: "admin" } })?.code).toBe("forbidden");
      expect(checkReactivate({ actor: "admin", actorId: "a1", target: { id: "u3", role: "agent" } })).toBeNull();
    });
  });

  it("limite de usuários: ativos + convites; null é ilimitado", () => {
    expect(isOverUserLimit(5, 5)).toBe(true);
    expect(isOverUserLimit(4, 5)).toBe(false);
    expect(isOverUserLimit(100, null)).toBe(false);
  });
});
