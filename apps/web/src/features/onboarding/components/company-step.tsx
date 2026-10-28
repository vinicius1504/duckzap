"use client";

import {
  companyStepSchema,
  type CompanyStepFormValues,
  type CompanyStepInput,
  type Weekday,
} from "@duckzap/contracts/onboarding";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { brand } from "@duckzap/brand";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { saveCompanyAction } from "../actions";

const dayLabels: Record<Weekday, string> = {
  mon: "Segunda",
  tue: "Terça",
  wed: "Quarta",
  thu: "Quinta",
  fri: "Sexta",
  sat: "Sábado",
  sun: "Domingo",
};

export function CompanyStep({ defaults }: { defaults: CompanyStepInput }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<CompanyStepFormValues, unknown, CompanyStepInput>({
    resolver: zodResolver(companyStepSchema),
    defaultValues: defaults,
  });
  const hours = watch("businessHours");

  async function onSubmit(values: CompanyStepInput) {
    setServerError(null);
    const result = await saveCompanyAction(values);
    if (result) {
      setServerError(result.error);
      return;
    }
    router.push("/comecar?passo=whatsapp");
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
      <div>
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">
          Conte um pouco sobre a sua empresa
        </h1>
        <p className="mt-1.5 text-ink-2">
          Isso ajuda o {brand.name} a responder no horário certo e com a sua cara.
        </p>
      </div>

      {serverError ? (
        <Alert tone="err" live>
          {serverError}
        </Alert>
      ) : null}

      <Card className="flex flex-col gap-5 p-7 max-sm:p-4">
        <div>
          <Label htmlFor="empresa-nome">Nome da empresa</Label>
          <Input
            id="empresa-nome"
            autoComplete="organization"
            placeholder="Casa Alvorada Odontologia"
            invalid={Boolean(errors.companyName)}
            aria-describedby={errors.companyName ? "empresa-nome-erro" : undefined}
            {...register("companyName")}
          />
          <FieldError id="empresa-nome-erro" message={errors.companyName?.message} />
        </div>

        <fieldset>
          <legend className="mb-1.5 text-[13px] font-semibold">Horário de atendimento</legend>
          <p className="mb-3 text-[13px] text-ink-2">
            Fora desse horário o agente avisa que a equipe responde depois.
          </p>
          <ul className="flex flex-col gap-2.5">
            {hours.map((day, index) => {
              const label = dayLabels[day.day];
              const rowError =
                errors.businessHours?.[index]?.closesAt?.message ??
                errors.businessHours?.[index]?.opensAt?.message;
              return (
                <li key={day.day} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="w-20 font-semibold">{label}</span>
                  <label className="inline-flex min-h-11 w-24 items-center gap-2 text-[13px]">
                    <Checkbox
                      {...register(`businessHours.${index}.open`, {
                        onChange: (event: { target: { checked: boolean } }) => {
                          if (
                            event.target.checked &&
                            !getValues(`businessHours.${index}.opensAt`)
                          ) {
                            setValue(`businessHours.${index}.opensAt`, "08:00");
                            setValue(`businessHours.${index}.closesAt`, "18:00");
                          }
                        },
                      })}
                    />
                    Aberto
                  </label>
                  <div className="flex min-w-[200px] flex-1 items-center gap-2">
                    <Input
                      type="time"
                      aria-label={`${label}, abre`}
                      // readOnly em vez de disabled: o react-hook-form descarta valores de campos desabilitados
                      readOnly={!day.open}
                      aria-disabled={!day.open || undefined}
                      tabIndex={day.open ? undefined : -1}
                      className={day.open ? "h-10 min-w-0" : "h-10 min-w-0 opacity-50"}
                      invalid={Boolean(rowError)}
                      {...register(`businessHours.${index}.opensAt`)}
                    />
                    <span className="text-ink-2" aria-hidden="true">
                      até
                    </span>
                    <Input
                      type="time"
                      aria-label={`${label}, fecha`}
                      // readOnly em vez de disabled: o react-hook-form descarta valores de campos desabilitados
                      readOnly={!day.open}
                      aria-disabled={!day.open || undefined}
                      tabIndex={day.open ? undefined : -1}
                      className={day.open ? "h-10 min-w-0" : "h-10 min-w-0 opacity-50"}
                      invalid={Boolean(rowError)}
                      aria-describedby={rowError ? `horario-${day.day}-erro` : undefined}
                      {...register(`businessHours.${index}.closesAt`)}
                    />
                  </div>
                  {rowError ? (
                    <p
                      id={`horario-${day.day}-erro`}
                      className="w-full text-[13px] font-semibold text-err"
                    >
                      {label}: {rowError}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <FieldError
            id="horario-erro"
            message={errors.businessHours?.root?.message ?? errors.businessHours?.message}
          />
        </fieldset>
      </Card>

      <div className="flex flex-wrap justify-end gap-3">
        <Button type="submit" variant="primary" size="lg" disabled={isSubmitting}>
          {isSubmitting ? <Spinner /> : null}
          {isSubmitting ? "Salvando…" : "Continuar"}
        </Button>
      </div>
    </form>
  );
}
