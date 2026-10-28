"use client";

import { roleLabels } from "@duckzap/contracts/permissions";
import type { MemberRole } from "@duckzap/contracts/session";
import type { Member } from "@duckzap/contracts/team";
import { Avatar } from "@duckzap/ui/components/avatar";
import { Button } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert } from "@duckzap/ui/components/feedback";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import { cn } from "@duckzap/ui/cn";
import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/features/settings/components/confirm-dialog";
import { formatPhone } from "@/lib/format";
import { cancelInviteAction, resendInviteAction, resetPasswordAction, setMemberActiveAction } from "../actions";
import { canManageMember, requiresTwoFactor } from "../rules";
import { memberStatusView, roleChipClass } from "./labels";
import { MemberDialog } from "./member-dialog";

export function MembersTable({
  members,
  teams,
  actor,
  limitReached,
}: {
  members: Member[];
  teams: { id: string; name: string }[];
  actor: { id: string; role: MemberRole };
  limitReached: boolean;
}) {
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const activeOwners = members.filter((m) => m.role === "owner" && m.status === "active").length;
  const teamNames = (ids: string[]) =>
    ids.map((id) => teams.find((t) => t.id === id)?.name).filter(Boolean).join(", ") || "—";

  function resend(member: Member) {
    startTransition(async () => {
      const result = await resendInviteAction(member.id);
      setNotice(result.ok ? { tone: "ok", text: `Convite reenviado para ${member.email}.` } : { tone: "err", text: result.error });
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {notice ? (
        <Alert tone={notice.tone} live action={<Button size="sm" variant="ghost" onClick={() => setNotice(null)}>Fechar</Button>}>
          {notice.text}
        </Alert>
      ) : null}
      <Table minWidth={960}>
        <thead>
          <tr>
            <Th>Pessoa</Th>
            <Th>Telefone</Th>
            <Th>Papel</Th>
            <Th>Equipes</Th>
            <Th>Duas etapas</Th>
            <Th>Status</Th>
            <Th>
              <span className="sr-only">Ações</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const status = memberStatusView[member.status];
            const manageable = canManageMember(actor.role, member) && member.id !== actor.id;
            const lastOwner = member.role === "owner" && member.status === "active" && activeOwners <= 1;
            return (
              <tr key={member.id} className={cn(member.status === "inactive" && "opacity-75")}>
                <Td>
                  <div className="flex items-center gap-2.5">
                    <Avatar name={member.name} size="sm" />
                    <span className="min-w-0">
                      <strong>{member.name}</strong>
                      {member.id === actor.id ? <span className="text-ink-2"> (você)</span> : null}
                      <br />
                      <span className="text-ink-2">{member.email}</span>
                    </span>
                  </div>
                </Td>
                <Td>{member.phone ? formatPhone(member.phone) : "—"}</Td>
                <Td>
                  <Chip className={roleChipClass[member.role]}>{roleLabels[member.role]}</Chip>
                </Td>
                <Td>{teamNames(member.teamIds)}</Td>
                <Td>
                  {member.status === "invited" ? (
                    <span className="text-ink-2">—</span>
                  ) : member.twoFactorEnabled ? (
                    <Chip tone="ok">Ativa</Chip>
                  ) : requiresTwoFactor(member.role) ? (
                    <Chip tone="err">Obrigatória, pendente</Chip>
                  ) : (
                    <Chip>Desativada</Chip>
                  )}
                </Td>
                <Td>
                  <Chip tone={status.tone}>{status.label}</Chip>
                </Td>
                <Td>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {member.status === "invited" ? (
                      <>
                        <Button size="sm" disabled={pending} onClick={() => resend(member)} aria-label={`Reenviar convite: ${member.name}`}>
                          Reenviar convite
                        </Button>
                        {manageable ? (
                          <ConfirmDialog
                            trigger={
                              <Button size="sm" variant="ghost" className="text-err" aria-label={`Cancelar convite: ${member.name}`}>
                                Cancelar
                              </Button>
                            }
                            title={`Cancelar o convite de ${member.name}?`}
                            description="O link enviado por e-mail deixa de funcionar e a vaga do plano é liberada."
                            confirmLabel="Cancelar convite"
                            danger
                            onConfirm={() => cancelInviteAction(member.id)}
                          />
                        ) : null}
                      </>
                    ) : null}

                    {member.status === "active" ? (
                      <>
                        <MemberDialog
                          trigger={
                            <Button size="sm" aria-label={`Editar: ${member.name}`}>
                              Editar
                            </Button>
                          }
                          member={member}
                          actorRole={actor.role}
                          teams={teams}
                          lastOwner={lastOwner}
                        />
                        {member.id !== actor.id ? (
                          <ConfirmDialog
                            trigger={
                              <Button size="sm" variant="ghost" aria-label={`Redefinir senha: ${member.name}`}>
                                Redefinir senha
                              </Button>
                            }
                            title={`Redefinir a senha de ${member.name}?`}
                            description={`Enviamos para ${member.email} um link para criar uma senha nova. A senha atual continua valendo até lá.`}
                            confirmLabel="Enviar link"
                            onConfirm={async () => {
                              const result = await resetPasswordAction(member.id);
                              if (result.ok) setNotice({ tone: "ok", text: `Link de nova senha enviado para ${result.data.email}.` });
                              return result;
                            }}
                          />
                        ) : null}
                        {manageable && !lastOwner ? (
                          <ConfirmDialog
                            trigger={
                              <Button size="sm" variant="ghost" className="text-err" aria-label={`Inativar: ${member.name}`}>
                                Inativar
                              </Button>
                            }
                            title={`Inativar ${member.name}?`}
                            description="A pessoa perde o acesso na hora e as conversas dela voltam para a fila da equipe. Dá para reativar depois."
                            confirmLabel="Inativar"
                            danger
                            onConfirm={() => setMemberActiveAction(member.id, false)}
                          />
                        ) : null}
                      </>
                    ) : null}

                    {member.status === "inactive" && manageable ? (
                      <ConfirmDialog
                        trigger={
                          <Button size="sm" disabled={limitReached} aria-label={`Reativar: ${member.name}`} title={limitReached ? "Limite de usuários do plano atingido" : undefined}>
                            Reativar
                          </Button>
                        }
                        title={`Reativar ${member.name}?`}
                        description="A pessoa volta a entrar com a mesma senha e passa a contar no limite de usuários do plano."
                        confirmLabel="Reativar"
                        onConfirm={() => setMemberActiveAction(member.id, true)}
                      />
                    ) : null}
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
