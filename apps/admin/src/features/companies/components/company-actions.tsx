"use client";

import {
  changeCompanyPlanSchema,
  extendCompanySchema,
  setCompanyEnabledSchema,
  type AdminActionResult,
  type Company,
  type Plan,
} from "@duckzap/contracts/admin";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Radio } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { cn } from "@duckzap/ui/cn";
import { useId, useState, useTransition, type ReactNode } from "react";
import { ReasonField } from "@/components/reason-field";
import { useToast } from "@/components/toast";
import { addDays, formatDay, todayIso } from "@/lib/format";
import { changeCompanyPlanAction, extendCompanyAction, setCompanyEnabledAction } from "../actions";

type Kind = "plan" | "extend" | "toggle";

export const dangerButton =
  "border-err bg-err text-surface hover:border-err hover:bg-err hover:opacity-90";

/** Botões de ação de uma empresa (linha da tabela ou gaveta) com os diálogos de confirmação. */
export function CompanyActions({
  company,
  plans,
  variant,
}: {
  company: Company;
  plans: Plan[];
  /** "row": só as ações do design para a situação; "full": todas (gaveta). */
  variant: "row" | "full";
}) {
  const [open, setOpen] = useState<Kind | null>(null);
  const late = company.status === "overdue" || company.status === "expired";

  let buttons: { kind: Kind; label: string; primary?: boolean; danger?: boolean }[];
  if (variant === "full") {
    buttons = [
      { kind: "plan", label: "Alterar plano" },
      { kind: "extend", label: "Prorrogar", primary: late || company.status === "past_due" },
      company.enabled
        ? { kind: "toggle", label: "Desativar", danger: true }
        : { kind: "toggle", label: "Ativar", primary: true },
    ];
  } else if (!company.enabled) {
    buttons = [{ kind: "toggle", label: "Ativar" }];
  } else if (company.status === "past_due") {
    buttons = [
      { kind: "plan", label: "Alterar plano" },
      { kind: "toggle", label: "Desativar" },
    ];
  } else {
    buttons = [
      { kind: "plan", label: "Alterar plano" },
      { kind: "extend", label: "Prorrogar", primary: late },
    ];
  }

  return (
    <>
      <div className={cn("flex flex-wrap gap-2", variant === "full" && "gap-2.5")}>
        {buttons.map((b) => (
          <Button
            key={b.kind}
            size={variant === "row" ? "sm" : "md"}
            variant={b.primary ? "primary" : "secondary"}
            className={cn(b.danger && "text-err")}
            aria-label={variant === "row" ? `${b.label}: ${company.name}` : undefined}
            onClick={() => setOpen(b.kind)}
          >
            {b.label}
          </Button>
        ))}
      </div>
      <Dialog open={open === "plan"} onOpenChange={(o) => setOpen(o ? "plan" : null)}>
        {open === "plan" ? (
          <ChangePlanDialog company={company} plans={plans} onDone={() => setOpen(null)} />
        ) : null}
      </Dialog>
      <Dialog open={open === "extend"} onOpenChange={(o) => setOpen(o ? "extend" : null)}>
        {open === "extend" ? <ExtendDialog company={company} onDone={() => setOpen(null)} /> : null}
      </Dialog>
      <Dialog open={open === "toggle"} onOpenChange={(o) => setOpen(o ? "toggle" : null)}>
        {open === "toggle" ? <ToggleDialog company={company} onDone={() => setOpen(null)} /> : null}
      </Dialog>
    </>
  );
}

/** Estado comum: envio, erro do servidor e aviso de sucesso. */
function useSubmit(onDone: () => void) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function submit(run: () => Promise<AdminActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await run();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast("ok", result.message);
      onDone();
    });
  }
  return { pending, error, submit };
}

function Footer({ pending, label, danger }: { pending: boolean; label: string; danger?: boolean }) {
  return (
    <DialogFooter>
      <DialogClose asChild>
        <Button disabled={pending}>Cancelar</Button>
      </DialogClose>
      <Button
        type="submit"
        variant="primary"
        disabled={pending}
        className={cn(danger && dangerButton)}
      >
        {pending ? <Spinner /> : null}
        {pending ? "Salvando…" : label}
      </Button>
    </DialogFooter>
  );
}

function FormBody({ children, onSubmit }: { children: ReactNode; onSubmit: () => void }) {
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

function limitsText(plan: Plan) {
  const agents =
    plan.limits.agents === null
      ? "agentes ilimitados"
      : `${plan.limits.agents} ${plan.limits.agents === 1 ? "agente" : "agentes"}`;
  return `${plan.limits.channels} canais · ${plan.limits.users} usuários · ${agents}`;
}

function ChangePlanDialog({
  company,
  plans,
  onDone,
}: {
  company: Company;
  plans: Plan[];
  onDone: () => void;
}) {
  const uid = useId();
  const options = plans.filter((p) => p.active || p.id === company.planId);
  const [planId, setPlanId] = useState(company.planId);
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<{ planId?: string; reason?: string }>({});
  const { pending, error, submit } = useSubmit(onDone);
  const chosen = plans.find((p) => p.id === planId);
  const over =
    chosen && planId !== company.planId
      ? [
          company.usage.channels > chosen.limits.channels
            ? `${company.usage.channels} canais (limite ${chosen.limits.channels})`
            : null,
          company.usage.users > chosen.limits.users
            ? `${company.usage.users} usuários (limite ${chosen.limits.users})`
            : null,
          chosen.limits.agents !== null && company.usage.agents > chosen.limits.agents
            ? `${company.usage.agents} agentes (limite ${chosen.limits.agents})`
            : null,
        ].filter((x): x is string => x !== null)
      : [];

  return (
    <DialogContent title="Alterar plano" description={company.name} size="md">
      <FormBody
        onSubmit={() => {
          if (planId === company.planId) {
            setFieldError({ planId: "Escolha um plano diferente do atual." });
            return;
          }
          const parsed = changeCompanyPlanSchema.safeParse({
            companyId: company.id,
            planId,
            reason,
          });
          if (!parsed.success) {
            setFieldError({ reason: parsed.error.issues[0]?.message });
            return;
          }
          setFieldError({});
          submit(() => changeCompanyPlanAction(parsed.data));
        }}
      >
        {error ? (
          <Alert tone="err" live>
            {error}
          </Alert>
        ) : null}
        <fieldset aria-describedby={fieldError.planId ? `${uid}-plano-erro` : undefined}>
          <legend className="mb-1.5 text-[13px] font-semibold">Novo plano</legend>
          <div className="flex flex-col gap-2">
            {options.map((plan) => {
              const current = plan.id === company.planId;
              return (
                <label
                  key={plan.id}
                  className={cn(
                    "flex min-h-14 cursor-pointer items-start gap-3 rounded-control border-2 border-line p-3",
                    planId === plan.id && "border-ink",
                  )}
                >
                  <Radio
                    name={`${uid}-plano`}
                    value={plan.id}
                    checked={planId === plan.id}
                    onChange={() => setPlanId(plan.id)}
                    className="mt-0.5"
                  />
                  <span className="flex-1">
                    <strong>{plan.name}</strong>
                    {current ? (
                      <span className="ml-2 text-xs font-semibold text-ink-2">Plano atual</span>
                    ) : null}
                    <span className="block text-[13px] text-ink-2">{limitsText(plan)}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {fieldError.planId ? (
            <p id={`${uid}-plano-erro`} className="mt-1.5 text-[13px] font-semibold text-err">
              {fieldError.planId}
            </p>
          ) : null}
        </fieldset>
        {company.onTrial ? (
          <Alert tone="info">
            A empresa está em teste. O teste continua até {formatDay(company.dueDate)} no novo
            plano.
          </Alert>
        ) : null}
        {over.length ? (
          <Alert tone="warn" title="Acima do limite:">
            a empresa usa {over.join(", ")}. Ela vai precisar desligar o excedente.
          </Alert>
        ) : null}
        <ReasonField
          id={`${uid}-motivo`}
          value={reason}
          length={reason.length}
          onChange={(e) => setReason(e.target.value)}
          error={fieldError.reason}
        />
        <Footer pending={pending} label="Alterar plano" />
      </FormBody>
    </DialogContent>
  );
}

const extendOptions = [7, 15, 30] as const;

function ExtendDialog({ company, onDone }: { company: Company; onDone: () => void }) {
  const uid = useId();
  const today = todayIso();
  // prorrogar conta a partir do vencimento atual ou de hoje, o que for mais tarde
  const base = company.dueDate > today ? company.dueDate : today;
  const [choice, setChoice] = useState<(typeof extendOptions)[number] | "custom">(7);
  const [customDate, setCustomDate] = useState(addDays(base, 7));
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<{ date?: string; reason?: string }>({});
  const { pending, error, submit } = useSubmit(onDone);
  const dueDate = choice === "custom" ? customDate : addDays(base, choice);
  const label = company.onTrial ? "fim do teste" : "vencimento";

  return (
    <DialogContent
      title={company.onTrial ? "Prorrogar teste" : "Prorrogar vencimento"}
      description={company.name}
      size="sm"
    >
      <FormBody
        onSubmit={() => {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || dueDate <= base) {
            setFieldError({ date: `Escolha uma data depois de ${formatDay(base)}.` });
            return;
          }
          const parsed = extendCompanySchema.safeParse({ companyId: company.id, dueDate, reason });
          if (!parsed.success) {
            setFieldError({ reason: parsed.error.issues[0]?.message });
            return;
          }
          setFieldError({});
          submit(() => extendCompanyAction(parsed.data));
        }}
      >
        {error ? (
          <Alert tone="err" live>
            {error}
          </Alert>
        ) : null}
        <p className="text-ink-2">
          {label.charAt(0).toUpperCase() + label.slice(1)} atual:{" "}
          <strong className="text-ink">{formatDay(company.dueDate)}</strong>
          {company.daysPastDue
            ? ` (há ${company.daysPastDue} ${company.daysPastDue === 1 ? "dia" : "dias"})`
            : null}
        </p>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-semibold">Prorrogar por</legend>
          <div className="flex flex-wrap gap-2">
            {extendOptions.map((days) => (
              <label
                key={days}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-2 rounded-control border-2 border-line px-3 font-semibold",
                  choice === days && "border-ink",
                )}
              >
                <Radio
                  name={`${uid}-dias`}
                  checked={choice === days}
                  onChange={() => setChoice(days)}
                />
                {days} dias
              </label>
            ))}
            <label
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-2 rounded-control border-2 border-line px-3 font-semibold",
                choice === "custom" && "border-ink",
              )}
            >
              <Radio
                name={`${uid}-dias`}
                checked={choice === "custom"}
                onChange={() => setChoice("custom")}
              />
              Outra data
            </label>
          </div>
        </fieldset>
        {choice === "custom" ? (
          <div>
            <Label htmlFor={`${uid}-data`}>Novo {label}</Label>
            <Input
              id={`${uid}-data`}
              type="date"
              min={addDays(base, 1)}
              value={customDate}
              invalid={Boolean(fieldError.date)}
              aria-describedby={fieldError.date ? `${uid}-data-erro` : undefined}
              onChange={(e) => setCustomDate(e.target.value)}
            />
          </div>
        ) : null}
        {fieldError.date ? (
          <p id={`${uid}-data-erro`} className="text-[13px] font-semibold text-err">
            {fieldError.date}
          </p>
        ) : (
          <Alert tone="info">
            Novo {label}:{" "}
            <strong>{/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? formatDay(dueDate) : "—"}</strong>
          </Alert>
        )}
        <ReasonField
          id={`${uid}-motivo`}
          value={reason}
          length={reason.length}
          onChange={(e) => setReason(e.target.value)}
          error={fieldError.reason}
        />
        <Footer pending={pending} label="Prorrogar" />
      </FormBody>
    </DialogContent>
  );
}

function ToggleDialog({ company, onDone }: { company: Company; onDone: () => void }) {
  const uid = useId();
  const enable = !company.enabled;
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const { pending, error, submit } = useSubmit(onDone);

  return (
    <DialogContent
      title={enable ? "Ativar empresa" : "Desativar empresa"}
      description={company.name}
      size="sm"
    >
      <FormBody
        onSubmit={() => {
          const parsed = setCompanyEnabledSchema.safeParse({
            companyId: company.id,
            enabled: enable,
            reason,
          });
          if (!parsed.success) {
            setFieldError(parsed.error.issues[0]?.message);
            return;
          }
          setFieldError(undefined);
          submit(() => setCompanyEnabledAction(parsed.data));
        }}
      >
        {error ? (
          <Alert tone="err" live>
            {error}
          </Alert>
        ) : null}
        {enable ? (
          <p className="text-ink-2">
            A equipe volta a entrar e os agentes voltam a responder. Se o vencimento já passou, a
            empresa continua com o aviso de pagamento até você prorrogar ou o pagamento cair.
          </p>
        ) : (
          <Alert tone="warn">
            A equipe perde o acesso, os agentes param de responder e as campanhas são pausadas.
            Conversas e clientes ficam guardados e voltam ao ativar.
          </Alert>
        )}
        <ReasonField
          id={`${uid}-motivo`}
          value={reason}
          length={reason.length}
          onChange={(e) => setReason(e.target.value)}
          error={fieldError}
        />
        <Footer
          pending={pending}
          label={enable ? "Ativar empresa" : "Desativar empresa"}
          danger={!enable}
        />
      </FormBody>
    </DialogContent>
  );
}
