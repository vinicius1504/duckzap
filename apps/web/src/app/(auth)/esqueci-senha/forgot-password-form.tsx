"use client";

import { Button } from "@duckzap/ui/components/button";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { requestPasswordResetAction } from "@/features/auth/actions";

const schema = z.object({
  email: z.email({ error: "Informe um e-mail válido." }).trim().toLowerCase(),
});
type Values = z.infer<typeof schema>;

export function ForgotPasswordForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "" } });

  async function onSubmit(values: Values) {
    setServerError(null);
    const result = await requestPasswordResetAction(values.email);
    if ("error" in result) {
      setServerError(result.error);
      return;
    }
    setSentTo(values.email);
  }

  if (sentTo) {
    // mensagem neutra: não revela se o e-mail tem conta
    return (
      <div className="flex flex-col items-start gap-4" role="status">
        <span className="flex size-12 items-center justify-center rounded-full bg-ok-bg text-ok">
          <Icon name="mail" size={24} />
        </span>
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">Confira seu e-mail</h1>
        <p className="text-ink-2">
          Se existir uma conta com <strong className="break-all text-ink">{sentTo}</strong>,
          enviamos um link para criar uma nova senha. O link vale por pouco tempo.
        </p>
        <p className="text-[13px] text-ink-2">
          Não chegou? Veja a caixa de spam ou tente de novo em alguns minutos.
        </p>
        <Button onClick={() => setSentTo(null)}>Usar outro e-mail</Button>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <div>
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">Esqueceu a senha?</h1>
        <p className="mt-1.5 text-ink-2">
          Informe seu e-mail e enviaremos um link para criar uma nova.
        </p>
      </div>
      {serverError ? (
        <Alert tone="err" live className="font-semibold">
          {serverError}
        </Alert>
      ) : null}
      <div>
        <Label htmlFor="email">E-mail</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="voce@empresa.com.br"
          invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? "email-erro" : undefined}
          {...register("email")}
        />
        <FieldError id="email-erro" message={errors.email?.message} />
      </div>
      <Button type="submit" variant="primary" size="lg" disabled={isSubmitting} className="w-full">
        {isSubmitting ? (
          <>
            <Spinner /> Enviando…
          </>
        ) : (
          "Enviar link"
        )}
      </Button>
    </form>
  );
}
