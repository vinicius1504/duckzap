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
import type { TwoFactorMethod } from "@duckzap/contracts/settings";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { sendTwoFactorEmailAction, signInAction, verifyTwoFactorAction } from "@/features/auth/actions";
import { safeNext } from "@/lib/safe-next";

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showPassword, setShowPassword] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // senha ok e conta com 2FA: pede o código (do app autenticador ou enviado por e-mail) antes de abrir a sessão
  const [twoFactor, setTwoFactor] = useState<TwoFactorMethod | null>(null);
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
      setTwoFactor(result.twoFactor);
      return;
    }
    finish();
  }

  function finish() {
    router.replace(safeNext(searchParams.get("next")));
    router.refresh();
  }

  if (twoFactor) {
    return (
      <TwoFactorStep
        key={twoFactor}
        method={twoFactor}
        onDone={finish}
        onRestart={() => setTwoFactor(null)}
        onUseApp={() => setTwoFactor("app")}
      />
    );
  }

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
            <Spinner size={16} /> Entrando…
          </>
        ) : (
          "Entrar"
        )}
      </Button>
    </form>
  );
}

/**
 * Segundo passo do login: código do app autenticador, ou código enviado por e-mail (pedido sozinho ao abrir), ou um
 * código de recuperação (os dois métodos aceitam).
 */
function TwoFactorStep({
  method,
  onDone,
  onRestart,
  onUseApp,
}: {
  method: TwoFactorMethod;
  onDone: () => void;
  onRestart: () => void;
  onUseApp: () => void;
}) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  // o e-mail sai UMA vez ao abrir (o React em dev roda o efeito duas vezes; o servidor também limita os envios)
  const sentOnce = useRef(false);

  async function sendEmail(again: boolean) {
    setError(null);
    setNotice(null);
    setSending(true);
    const result = await sendTwoFactorEmailAction();
    setSending(false);
    if (!result) return setNotice(again ? "Enviamos um código novo. Use o mais recente." : null);
    if (result.restart) return onRestart();
    if (result.useApp) return onUseApp();
    setError(result.error);
  }

  useEffect(() => {
    if (method !== "email" || sentOnce.current) return;
    sentOnce.current = true;
    void sendEmail(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só ao abrir o passo
  }, [method]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);
    const result = await verifyTwoFactorAction({ code, recovery, trustDevice, method });
    setPending(false);
    if (!result) return onDone();
    if (result.restart) return onRestart();
    setError(result.error);
  }

  const email = method === "email";
  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-extrabold">Verificação em duas etapas</h2>
        <p className="mt-1 text-ink-2">
          {recovery
            ? "Digite um dos seus códigos de recuperação. Cada um vale uma vez."
            : email
              ? sending
                ? "Enviando um código para o seu e-mail…"
                : "Enviamos um código de 6 números para o seu e-mail. Ele vale por 5 minutos."
              : "Digite o código de 6 dígitos do seu app autenticador."}
        </p>
      </div>
      {error ? (
        <Alert tone="err" live className="font-semibold">
          {error}
        </Alert>
      ) : null}
      {notice ? (
        <Alert tone="ok" live>
          {notice}
        </Alert>
      ) : null}
      <div>
        <Label htmlFor="codigo">{recovery ? "Código de recuperação" : email ? "Código do e-mail" : "Código do app"}</Label>
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
            <Spinner size={16} /> Verificando…
          </>
        ) : (
          "Entrar"
        )}
      </Button>
      <div className="flex flex-wrap justify-between gap-3 text-[13px] font-bold">
        <button type="button" className="underline" onClick={() => setRecovery((value) => !value)}>
          {recovery ? (email ? "Usar o código do e-mail" : "Usar o código do app") : "Usar código de recuperação"}
        </button>
        {email && !recovery ? (
          <button type="button" className="underline disabled:opacity-60" disabled={sending} onClick={() => void sendEmail(true)}>
            Reenviar código
          </button>
        ) : null}
        <button type="button" className="underline" onClick={onRestart}>
          Voltar
        </button>
      </div>
    </form>
  );
}
