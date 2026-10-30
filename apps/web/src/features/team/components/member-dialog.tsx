"use client";

import { roleLabels } from "@duckzap/contracts/permissions";
import { memberRoleSchema, type MemberRole } from "@duckzap/contracts/session";
import type { Member } from "@duckzap/contracts/team";
import { emailError } from "@duckzap/contracts/validation";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox, Select } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { useState, useTransition, type ReactElement } from "react";
import { EmailField } from "@/components/form-fields";
import { inviteMemberAction, updateMemberAction } from "../actions";
import { canAssignRole, canManageMember, requiresTwoFactor } from "../rules";

const roleHints: Record<MemberRole, string> = {
  owner: "Acesso total, inclusive plano e cobrança.",
  admin: "Gerencia canais, equipe, agentes e ajustes. Não mexe na cobrança.",
  agent: "Atende as conversas das suas equipes.",
};

/** Convidar pessoa (sem `member`) ou editar pessoa (com `member`). */
export function MemberDialog({
  trigger,
  member,
  actorRole,
  teams,
  lastOwner,
}: {
  trigger: ReactElement;
  member?: Member;
  actorRole: MemberRole;
  teams: { id: string; name: string }[];
  /** A pessoa é o único proprietário ativo: o papel não pode mudar. */
  lastOwner?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(member?.name ?? "");
  const [email, setEmail] = useState(member?.email ?? "");
  const [role, setRole] = useState<MemberRole>(member?.role ?? "agent");
  const [teamIds, setTeamIds] = useState<string[]>(member?.teamIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [pending, startTransition] = useTransition();
  const prefix = member ? `pessoa-${member.id}` : "convite";
  const roleLocked = Boolean(member && (lastOwner || !canManageMember(actorRole, member)));
  const roleOptions = memberRoleSchema.options.filter((r) => canAssignRole(actorRole, r) || r === member?.role);

  function reset() {
    setName(member?.name ?? "");
    setEmail(member?.email ?? "");
    setRole(member?.role ?? "agent");
    setTeamIds(member?.teamIds ?? []);
    setError(null);
    setSubmitted(false);
  }

  function submit() {
    setSubmitted(true);
    if (!member && emailError(email, { required: true })) {
      setError("Corrija o e-mail destacado.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = member
        ? await updateMemberAction(member.id, { name, role, teamIds })
        : await inviteMemberAction({ name, email, role, teamIds });
      if (result.ok) setOpen(false);
      else setError(result.error);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        title={member ? `Editar ${member.name}` : "Convidar pessoa"}
        description={member ? undefined : "A pessoa recebe um e-mail com o link para criar a senha. O convite vale 7 dias."}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-4"
          noValidate
        >
          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))]">
            <div>
              <Label htmlFor={`${prefix}-nome`}>Nome</Label>
              <Input id={`${prefix}-nome`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            </div>
            {member ? (
              <div>
                <Label htmlFor={`${prefix}-email`}>E-mail</Label>
                <Input id={`${prefix}-email`} type="email" value={email} readOnly aria-describedby={`${prefix}-email-dica`} required />
                <p id={`${prefix}-email-dica`} className="mt-1 text-xs text-ink-2">
                  Só a própria pessoa troca o e-mail, em Minha conta.
                </p>
              </div>
            ) : (
              <EmailField id={`${prefix}-email`} label="E-mail" value={email} onChange={setEmail} required showErrors={submitted} autoComplete="off" />
            )}
          </div>

          <div>
            <Label htmlFor={`${prefix}-papel`}>Papel</Label>
            <Select
              id={`${prefix}-papel`}
              value={role}
              disabled={roleLocked}
              aria-describedby={`${prefix}-papel-dica`}
              onChange={(e) => {
                const next = memberRoleSchema.safeParse(e.target.value);
                if (next.success) setRole(next.data);
              }}
            >
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {roleLabels[r]}
                </option>
              ))}
            </Select>
            <p id={`${prefix}-papel-dica`} className="mt-1 text-xs text-ink-2">
              {lastOwner
                ? "A empresa precisa de pelo menos um proprietário. Promova outra pessoa antes de mudar este papel."
                : roleLocked
                  ? "Só o proprietário muda o papel de um administrador ou proprietário."
                  : roleHints[role]}
            </p>
          </div>

          {requiresTwoFactor(role) && !member?.twoFactorEnabled ? (
            <Alert tone="info">
              {roleLabels[role]} precisa ativar a verificação em duas etapas no próximo acesso.
            </Alert>
          ) : null}

          <fieldset>
            <legend className="mb-1.5 text-[13px] font-semibold">Equipes</legend>
            {teams.length ? (
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {teams.map((team) => (
                  <label key={team.id} className="flex min-h-11 items-center gap-2.5">
                    <Checkbox
                      checked={teamIds.includes(team.id)}
                      onChange={(e) =>
                        setTeamIds((ids) => (e.target.checked ? [...ids, team.id] : ids.filter((id) => id !== team.id)))
                      }
                    />
                    {team.name}
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-ink-2">Nenhuma equipe criada ainda.</p>
            )}
          </fieldset>

          {error ? (
            <Alert tone="err" live>
              {error}
            </Alert>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button>Cancelar</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Salvando…" : member ? "Salvar" : "Enviar convite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
