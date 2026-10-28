import { describe, expect, it } from "vitest";
import { AuditReasonError, writeAudit, type Executor } from "./audit";

function fakeExecutor() {
  const inserted: Record<string, unknown>[] = [];
  const executor = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        inserted.push(row);
      },
    }),
  } as unknown as Executor;
  return { executor, inserted };
}

const base = {
  kind: "mutation" as const,
  actor: { id: "7f1b3a66-0000-7000-8000-000000000001", name: "Bruno", email: "bruno@duckchat.com.br" },
  action: "company.plan_changed",
  target: { type: "company", id: "org_x", name: "Empresa X" },
  company: { id: "org_x", name: "Empresa X" },
  changes: [{ field: "Plano", from: "Pro", to: "Escala" }],
  ip: "177.12.40.8",
};

describe("writeAudit", () => {
  it("recusa mutação sem motivo (nada é gravado)", async () => {
    const { executor, inserted } = fakeExecutor();
    await expect(writeAudit(executor, { ...base, reason: "curto" })).rejects.toBeInstanceOf(AuditReasonError);
    await expect(writeAudit(executor, { ...base, reason: "         " })).rejects.toBeInstanceOf(AuditReasonError);
    expect(inserted).toHaveLength(0);
  });

  it("grava quem, o quê, empresa, antes→depois, motivo e IP", async () => {
    const { executor, inserted } = fakeExecutor();
    await writeAudit(executor, { ...base, reason: "  Cliente pediu upgrade por telefone.  ", before: { planId: "pro" }, after: { planId: "escala" } });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      kind: "mutation",
      actorId: base.actor.id,
      actorEmail: "bruno@duckchat.com.br",
      action: "company.plan_changed",
      targetType: "company",
      companyId: "org_x",
      reason: "Cliente pediu upgrade por telefone.",
      before: { planId: "pro" },
      after: { planId: "escala" },
      changes: base.changes,
      ip: "177.12.40.8",
    });
  });

  it("eventos de autenticação não exigem motivo longo", async () => {
    const { executor, inserted } = fakeExecutor();
    await writeAudit(executor, { ...base, kind: "auth", action: "admin.sign_in", reason: "login", changes: [] });
    expect(inserted).toHaveLength(1);
  });
});
