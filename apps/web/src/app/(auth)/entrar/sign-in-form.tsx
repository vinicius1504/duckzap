"use client";

import { signInSchema, type SignInInput } from "@duckzap/contracts/auth";
import { Button } from "@duckzap/ui/components/button";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { signInAction, verifyTwoFactorAction } from "@/features/auth/actions";
import { safeNext } from "@/lib/safe-next";

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showPassword, setShowPassword] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // senha ok e conta com 2FA: pede o código do app autenticador antes de abrir a sessão
  const [twoFactor, setTwoFactor] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "", rememberMe: true },
  });

  async function onSubmit(values: SignInInput) {
    setServerError(null);
    const result = await signInAction(values);
    if (result && "error" in result) {
      setServerError(result.error);
      return;
    }
    if (result && "twoFactor" in result) {
      setTwoFactor(true);
      return;
    }
    finish();
  }

  function finish() {
    router.replace(safeNext(searchParams.get("next")));
    router.refresh();
  }

  if (twoFactor) return <TwoFactorStep onDone={finish} onRestart={() => setTwoFactor(false)} />;

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
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
          invalid={Boolean(errors.email || serverError)}
          aria-describedby={errors.email ? "email-erro" : undefined}
          {...register("email")}
        />
        <FieldError id="email-erro" message={errors.email?.message} />
      </div>

      <div>
        <Label htmlFor="senha">Senha</Label>
        <div className="relative">
          <Input
            id="senha"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            className="pr-12"
            invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? "senha-erro" : undefined}
            {...register("password")}
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
            aria-pressed={showPassword}
            className="absolute right-1 top-1 flex size-9 items-center justify-center rounded-lg text-ink-2"
          >
            <Icon name={showPassword ? "eyeOff" : "eye"} />
          </button>
        </div>
        <FieldError id="senha-erro" message={errors.password?.message} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex min-h-11 items-center gap-2 text-[13px]">
          <Checkbox {...register("rememberMe")} />
          Manter conectado
        </label>
        <Link href="/esqueci-senha" className="text-[13px] font-bold underline">
          Esqueci a senha
        </Link>
      </div>

      <Button type="submit" variant="primary" size="lg" disabled={isSubmitting} className="w-full">
        {isSubmitting ? (
          <>
            <Spinner /> Entrando…
          </>
        ) : (
          "Entrar"
        )}
      </Button>
    </form>
  );
}

/** Segundo passo do login: código do app autenticador (ou código de recuperação). */
function TwoFactorStep({ onDone, onRestart }: { onDone: () => void; onRestart: () => void }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const result = await verifyTwoFactorAction({ code, recovery, trustDevice });
    setPending(false);
    if (!result) return onDone();
    if (result.restart) return onRestart();
    setError(result.error);
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-extrabold">Verificação em duas etapas</h2>
        <p className="mt-1 text-ink-2">
          {recovery
            ? "Digite um dos seus códigos de recuperação. Cada um vale uma vez."
            : "Digite o código de 6 dígitos do seu app autenticador."}
        </p>
      </div>
      {error ? (
        <Alert tone="err" live className="font-semibold">
          {error}
        </Alert>
      ) : null}
      <div>
        <Label htmlFor="codigo">{recovery ? "Código de recuperação" : "Código do app"}</Label>
        <Input
          id="codigo"
          inputMode={recovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value)}
          invalid={Boolean(error)}
        />
      </div>
      <label className="inline-flex min-h-11 items-center gap-2 text-[13px]">
        <Checkbox checked={trustDevice} onChange={(event) => setTrustDevice(event.target.checked)} />
        Confiar neste aparelho por 30 dias
      </label>
      <Button type="submit" variant="primary" size="lg" disabled={pending || code.trim().length < 6} className="w-full">
        {pending ? (
          <>
            <Spinner /> Verificando…
          </>
        ) : (
          "Entrar"
        )}
      </Button>
      <div className="flex flex-wrap justify-between gap-3 text-[13px] font-bold">
        <button type="button" className="underline" onClick={() => setRecovery((value) => !value)}>
          {recovery ? "Usar o código do app" : "Usar código de recuperação"}
        </button>
        <button type="button" className="underline" onClick={onRestart}>
          Voltar
        </button>
      </div>
    </form>
  );
}
