import { schema, type Database, type Transaction } from "@duckzap/db";
import { v7 as uuidv7 } from "uuid";
import { validateReason, type Change } from "./logic";

export type Executor = Database | Transaction;

export type AuditActor = { id: string | null; name: string; email: string };

export type AuditEntryInput = {
  kind: "mutation" | "auth";
  actor: AuditActor;
  action: string;
  target: { type: string; id: string; name: string };
  company?: { id: string; name: string } | null;
  reason: string;
  before?: unknown;
  after?: unknown;
  changes?: Change[];
  ip: string | null;
};

export class AuditReasonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditReasonError";
  }
}

/**
 * Grava uma linha em `audit_logs`. Para ações que alteram dados (`kind = "mutation"`) o motivo é obrigatório
 * (≥ 10 caracteres) — validado aqui E por check no banco. Chame SEMPRE com a `tx` da mutação:
 * se a auditoria falhar, a mudança é desfeita (e vice-versa).
 */
export async function writeAudit(executor: Executor, entry: AuditEntryInput): Promise<string> {
  let reason = entry.reason.trim();
  if (entry.kind === "mutation") {
    const checked = validateReason(entry.reason);
    if (!checked.ok) throw new AuditReasonError(checked.message);
    reason = checked.reason;
  }
  const id = uuidv7();
  await executor.insert(schema.auditLogs).values({
    id,
    kind: entry.kind,
    actorId: entry.actor.id,
    actorName: entry.actor.name,
    actorEmail: entry.actor.email,
    action: entry.action,
    targetType: entry.target.type,
    targetId: entry.target.id,
    targetName: entry.target.name,
    companyId: entry.company?.id ?? null,
    companyName: entry.company?.name ?? null,
    reason,
    before: entry.before ?? null,
    after: entry.after ?? null,
    changes: entry.changes ?? [],
    ip: entry.ip,
  });
  return id;
}
