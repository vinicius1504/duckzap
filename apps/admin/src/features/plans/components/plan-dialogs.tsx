"use client";

import { planInputSchema, type Plan, type PlanInput } from "@duckzap/contracts/admin";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { Switch } from "@duckzap/ui/components/switch";
import { cn } from "@duckzap/ui/cn";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState, useTransition } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { ReasonField } from "@/components/reason-field";
import { useToast } from "@/components/toast";
import { centsToInput, parseMoneyInput } from "@/lib/format";
import { deletePlanAction, savePlanAction } from "../actions";
import { planFeatureLabels, planFeatureOrder } from "../view";

const money = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(parseMoneyInput(v) ?? 0), {
    error: "Use um valor como 99,90 (ou deixe vazio).",
  });
const limit = z
  .string()
  .trim()
  .regex(/^\d{1,3}$/, { error: "Use um número de 1 a 999." })
  .refine((v) => Number(v) >= 1, { error: "Use um número de 1 a 999." });

/** Campos como texto (o que a pessoa digita); vira `PlanInput` (centavos, null) ao enviar. */
const formSchema = z
  .object({
    name: planInputSchema.shape.name,
    firstMonthPrice: money,
    recurringPrice: money,
    channels: limit,
    users: limit,
    agentsUnlimited: z.boolean(),
    agents: z.string().trim(),
    campaigns: z.boolean(),
    instagram: z.boolean(),
    copilot: z.boolean(),
    checkoutUrl: z
      .string()
      .trim()
      .refine((v) => v === "" || z.url({ protocol: /^https$/ }).safeParse(v).success, {
        error: "Use um link https:// válido (ou deixe vazio).",
      }),
    active: z.boolean(),
    reason: planInputSchema.shape.reason,
  })
  .refine((v) => v.agentsUnlimited || limit.safeParse(v.agents).success, {
    error: "Use um número de 1 a 999 ou marque ilimitados.",
    path: ["agents"],
  });

type FormValues = z.infer<typeof formSchema>;

function toFormValues(plan: Plan | null): FormValues {
  return {
    name: plan?.name ?? "",
    firstMonthPrice: centsToInput(plan?.firstMonthPriceCents ?? null),
    recurringPrice: centsToInput(plan?.recurringPriceCents ?? null),
    channels: String(plan?.limits.channels ?? 2),
    users: String(plan?.limits.users ?? 2),
    agentsUnlimited: plan ? plan.limits.agents === null : false,
    agents: plan?.limits.agents === null || !plan ? "1" : String(plan.limits.agents),
    campaigns: plan?.features.campaigns ?? false,
    instagram: plan?.features.instagram ?? false,
    copilot: plan?.features.copilot ?? false,
    checkoutUrl: plan?.checkoutUrl ?? "",
    active: plan?.active ?? true,
    reason: "",
  };
}

function toInput(values: FormValues): PlanInput {
  const cents = (v: string) => {
    const parsed = parseMoneyInput(v);
    return parsed === null || Number.isNaN(parsed) ? null : parsed;
  };
  return {
    name: values.name,
    firstMonthPriceCents: cents(values.firstMonthPrice),
    recurringPriceCents: cents(values.recurringPrice),
    limits: {
      channels: Number(values.channels),
      users: Number(values.users),
      agents: values.agentsUnlimited ? null : Number(values.agents),
    },
    features: { campaigns: values.campaigns, instagram: values.instagram, copilot: values.copilot },
    checkoutUrl: values.checkoutUrl.trim() === "" ? null : values.checkoutUrl.trim(),
    active: values.active,
    reason: values.reason,
  };
}

/** Botão + diálogo de criar/editar plano. */
export function PlanFormButton({ plan }: { plan: Plan | null }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {plan ? (
        <Button size="sm" onClick={() => setOpen(true)} aria-label={`Editar plano ${plan.name}`}>
          Editar
        </Button>
      ) : (
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Icon name="plus" size={18} strokeWidth={2.2} />
          Novo plano
        </Button>
      )}
      {open ? <PlanForm plan={plan} onDone={() => setOpen(false)} /> : null}
    </Dialog>
  );
}

function PlanForm({ plan, onDone }: { plan: Plan | null; onDone: () => void }) {
  const uid = useId();
  const toast = useToast();
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: toFormValues(plan) });
  const unlimited = watch("agentsUnlimited");
  const reason = watch("reason");
  const active = watch("active");

  async function onSubmit(values: FormValues) {
    setServerError(null);
    const result = await savePlanAction(plan?.id ?? null, toInput(values));
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    toast("ok", result.message);
    onDone();
  }

  const field = (name: keyof FormValues) => ({
    id: `${uid}-${name}`,
    invalid: Boolean(errors[name]),
    "aria-describedby": errors[name] ? `${uid}-${name}-erro` : undefined,
  });

  if (confirmDelete && plan) {
    return <DeletePlan plan={plan} onCancel={() => setConfirmDelete(false)} onDone={onDone} />;
  }

  return (
    <DialogContent
      title={plan ? `Editar plano ${plan.name}` : "Novo plano"}
      description={
        plan && plan.companiesCount > 0
          ? `${plan.companiesCount} ${plan.companiesCount === 1 ? "empresa usa" : "empresas usam"} este plano. Mudanças de limite valem para elas também.`
          : "Limites e recursos valem no back; a tela só mostra (§1.2)."
      }
      size="lg"
    >
      <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">
        {serverError ? (
          <Alert tone="err" live>
            {serverError}
          </Alert>
        ) : null}

        <div>
          <Label htmlFor={`${uid}-name`}>Nome do plano</Label>
          <Input {...field("name")} placeholder="Ex.: Pro" {...register("name")} />
          <FieldError id={`${uid}-name-erro`} message={errors.name?.message} />
        </div>

        <fieldset className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))]">
          <legend className="mb-2 font-bold">Preço</legend>
          <div>
            <Label htmlFor={`${uid}-firstMonthPrice`}>1º mês (R$)</Label>
            <Input
              {...field("firstMonthPrice")}
              inputMode="decimal"
              placeholder="[VALOR]"
              {...register("firstMonthPrice")}
            />
            <FieldError
              id={`${uid}-firstMonthPrice-erro`}
              message={errors.firstMonthPrice?.message}
            />
          </div>
          <div>
            <Label htmlFor={`${uid}-recurringPrice`}>Meses seguintes (R$)</Label>
            <Input
              {...field("recurringPrice")}
              inputMode="decimal"
              placeholder="[VALOR]"
              {...register("recurringPrice")}
            />
            <FieldError
              id={`${uid}-recurringPrice-erro`}
              message={errors.recurringPrice?.message}
            />
          </div>
          <p className="col-span-full -mt-2 text-xs text-ink-2">
            Vazio = preço a definir (aparece como “R$ [VALOR]”).
          </p>
        </fieldset>

        <fieldset className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr))]">
          <legend className="mb-2 font-bold">Limites</legend>
          <div>
            <Label htmlFor={`${uid}-channels`}>Canais</Label>
            <Input {...field("channels")} inputMode="numeric" {...register("channels")} />
            <FieldError id={`${uid}-channels-erro`} message={errors.channels?.message} />
          </div>
          <div>
            <Label htmlFor={`${uid}-users`}>Usuários</Label>
            <Input {...field("users")} inputMode="numeric" {...register("users")} />
            <FieldError id={`${uid}-users-erro`} message={errors.users?.message} />
          </div>
          <div>
            <Label htmlFor={`${uid}-agents`}>Agentes de IA</Label>
            <Input
              {...field("agents")}
              inputMode="numeric"
              disabled={unlimited}
              {...register("agents")}
            />
            <label className="mt-1 inline-flex min-h-11 items-center gap-2 text-[13px]">
              <Checkbox {...register("agentsUnlimited")} />
              Ilimitados
            </label>
            <FieldError id={`${uid}-agents-erro`} message={errors.agents?.message} />
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 font-bold">Recursos</legend>
          <div className="flex flex-wrap gap-2">
            {planFeatureOrder.map((feature) => (
              <label
                key={feature}
                className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-control border border-line px-3 font-semibold"
              >
                <Checkbox {...register(feature)} />
                {planFeatureLabels[feature]}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <Label htmlFor={`${uid}-checkoutUrl`}>Link de checkout</Label>
          <Input
            {...field("checkoutUrl")}
            type="url"
            placeholder="https://… ([LINK])"
            {...register("checkoutUrl")}
          />
          <FieldError id={`${uid}-checkoutUrl-erro`} message={errors.checkoutUrl?.message} />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-control bg-bg p-3">
          <div>
            <p id={`${uid}-active-label`} className="font-semibold">
              Plano ativo
            </p>
            <p className="text-[13px] text-ink-2">
              {active
                ? "Aparece para novas contratações."
                : "Some das novas contratações; quem já tem continua."}
            </p>
          </div>
          <Controller
            control={control}
            name="active"
            render={({ field: f }) => (
              <Switch
                aria-labelledby={`${uid}-active-label`}
                checked={f.value}
                onCheckedChange={f.onChange}
              />
            )}
          />
        </div>

        <ReasonField
          id={`${uid}-reason`}
          length={reason.length}
          error={errors.reason?.message}
          {...register("reason")}
        />

        <DialogFooter className={cn(plan && "justify-between")}>
          {plan ? (
            <Button
              className="text-err"
              onClick={() => setConfirmDelete(true)}
              disabled={isSubmitting}
            >
              <Icon name="trash" size={18} />
              Excluir
            </Button>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <DialogClose asChild>
              <Button disabled={isSubmitting}>Cancelar</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={isSubmitting}>
              {isSubmitting ? <Spinner /> : null}
              {isSubmitting ? "Salvando…" : plan ? "Salvar plano" : "Criar plano"}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function DeletePlan({
  plan,
  onCancel,
  onDone,
}: {
  plan: Plan;
  onCancel: () => void;
  onDone: () => void;
}) {
  const uid = useId();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const inUse = plan.companiesCount > 0;

  return (
    <DialogContent title={`Excluir plano ${plan.name}`} size="sm">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = planInputSchema.shape.reason.safeParse(reason);
          if (!parsed.success) {
            setFieldError(parsed.error.issues[0]?.message);
            return;
          }
          setFieldError(undefined);
          setError(null);
          startTransition(async () => {
            const result = await deletePlanAction(plan.id, parsed.data);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            toast("ok", result.message);
            onDone();
          });
        }}
      >
        {error ? (
          <Alert tone="err" live>
            {error}
          </Alert>
        ) : null}
        {inUse ? (
          <Alert tone="warn">
            {plan.companiesCount} {plan.companiesCount === 1 ? "empresa usa" : "empresas usam"} este
            plano. Não dá para excluir: desative o plano para tirá-lo das novas contratações.
          </Alert>
        ) : (
          <p className="text-ink-2">O plano some da lista. Isso não pode ser desfeito.</p>
        )}
        {inUse ? null : (
          <ReasonField
            id={`${uid}-motivo`}
            value={reason}
            length={reason.length}
            onChange={(e) => setReason(e.target.value)}
            error={fieldError}
          />
        )}
        <DialogFooter>
          <Button onClick={onCancel} disabled={pending}>
            Voltar
          </Button>
          {inUse ? null : (
            <Button
              type="submit"
              variant="primary"
              disabled={pending}
              className="border-err bg-err text-surface hover:border-err hover:bg-err hover:opacity-90"
            >
              {pending ? <Spinner /> : null}
              {pending ? "Excluindo…" : "Excluir plano"}
            </Button>
          )}
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
