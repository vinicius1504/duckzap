"use client";

import { signUpSchema } from "@duckzap/contracts/onboarding";
import { Button } from "@duckzap/ui/components/button";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { useState, useTransition } from "react";
import { acceptInviteAction } from "../actions";

/** `needsPassword`: conta nova (cria a senha). Senão a pessoa já está logada com o e-mail do convite. */
export function AcceptInviteForm({ token, needsPassword }: { token: string; needsPassword: boolean }) {
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setServerError(null);
    if (needsPassword) {
      const parsed = signUpSchema.shape.password.safeParse(password);
      if (!parsed.success) {
        setFieldError(parsed.error.issues[0]?.message ?? "Confira a senha.");
        return;
      }
    }
    setFieldError(null);
    startTransition(async () => {
      const result = await acceptInviteAction(token, needsPassword ? password : null);
      if (result) setServerError(result.error);
    });
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-4"
    >
      {serverError ? (
        <Alert tone="err" live className="font-semibold">
          {serverError}
        </Alert>
      ) : null}
      {needsPassword ? (
        <div>
          <Label htmlFor="senha">Crie uma senha</Label>
          <Input
            id="senha"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            invalid={Boolean(fieldError)}
            aria-describedby={fieldError ? "senha-erro" : undefined}
          />
          <FieldError id="senha-erro" message={fieldError ?? undefined} />
          <p className="mt-1 text-[13px] text-ink-2">Pelo menos 8 caracteres, com letra e número.</p>
        </div>
      ) : null}
      <Button type="submit" variant="primary" size="lg" disabled={pending} className="w-full">
        {pending ? (
          <>
            <Spinner /> Entrando…
          </>
        ) : needsPassword ? (
          "Criar conta e entrar"
        ) : (
          "Aceitar convite"
        )}
      </Button>
    </form>
  );
}
