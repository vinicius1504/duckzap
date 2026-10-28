"use client";

import { adminSignInSchema, type AdminSignInInput } from "@duckzap/contracts/admin";
import { Button } from "@duckzap/ui/components/button";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import {
  cancelSignInAction,
  startSignInAction,
  verifyTwoFactorAction,
  type Enrollment,
} from "@/features/auth/actions";
import { safeNext } from "@/lib/safe-next";

/** Login em dois passos: senha e depois o código do app autenticador (2FA obrigatório, §5.1). */
export function AdminSignInForm({
  pendingEmail,
  pendingEnrollment = null,
}: {
  pendingEmail: string | null;
  pendingEnrollment?: Enrollment | null;
}) {
  const [email, setEmail] = useState<string | null>(pendingEmail);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(pendingEnrollment);
  const [notice, setNotice] = useState<string | null>(null);

  if (email) {
    return (
      <TwoFactorStep
        email={email}
        enrollment={enrollment}
        onRestart={(message) => {
          setNotice(message);
          setEmail(null);
        }}
      />
    );
  }
  return (
    <PasswordStep
      notice={notice}
      onNext={(value, nextEnrollment) => {
        setNotice(null);
        setEnrollment(nextEnrollment);
        setEmail(value);
      }}
    />
  );
}

function PasswordStep({
  notice,
  onNext,
}: {
  notice: string | null;
  onNext: (email: string, enrollment: Enrollment | null) => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // 1º acesso: depois da senha, o servidor pode pedir o código de ativação (gerado por script)
  const [needsActivationCode, setNeedsActivationCode] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AdminSignInInput>({
    resolver: zodResolver(adminSignInSchema),
    defaultValues: { email: "", password: "", activationCode: "" },
  });

  async function onSubmit(values: AdminSignInInput) {
    setServerError(null);
    const result = await startSignInAction(values);
    if ("error" in result) {
      setServerError(result.error);
      if (result.needsActivationCode) setNeedsActivationCode(true);
      return;
    }
    onNext(result.email, result.enrollment);
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-[-0.02em]">Entrar no painel</h1>
        <p className="mt-1 text-ink-2">
          Use seu e-mail da equipe. Depois pedimos o código do app autenticador.
        </p>
      </div>

      {notice && !serverError ? (
        <Alert tone="warn" live>
          {notice}
        </Alert>
      ) : null}
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
          autoComplete="username"
          placeholder="voce@duckchat.com.br"
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

      {needsActivationCode ? (
        <div>
          <Label htmlFor="ativacao">Código de ativação (primeiro acesso)</Label>
          <Input id="ativacao" autoComplete="off" spellCheck={false} {...register("activationCode")} />
          <p className="mt-1.5 text-[13px] text-ink-2">
            Peça à equipe técnica o código de uso único deste acesso. Ele só é pedido na primeira vez.
          </p>
        </div>
      ) : null}

      <Button type="submit" variant="primary" size="lg" disabled={isSubmitting} className="w-full">
        {isSubmitting ? (
          <>
            <Spinner /> Verificando…
          </>
        ) : (
          "Continuar"
        )}
      </Button>
    </form>
  );
}

function TwoFactorStep({
  email,
  enrollment,
  onRestart,
}: {
  email: string;
  enrollment: Enrollment | null;
  onRestart: (message: string | null) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  const focusCode = () => document.getElementById("codigo")?.focus();
  useEffect(focusCode, []);

  function submit() {
    if (!/^\d{6}$/.test(code)) {
      setError("O código tem 6 números.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await verifyTwoFactorAction(code);
      if (result) {
        if (result.restart) onRestart(result.error);
        else {
          setError(result.error);
          setCode("");
          focusCode();
        }
        return;
      }
      setDone(true);
      router.replace(safeNext(searchParams.get("next")));
      router.refresh();
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
      <div>
        <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-info-bg text-info">
          <Icon name="key" size={24} />
        </span>
        <h1 className="text-2xl font-extrabold tracking-[-0.02em]">Código de verificação</h1>
        <p className="mt-1 text-ink-2">
          Abra o app autenticador da conta <strong className="break-all text-ink">{email}</strong> e
          digite o código de 6 números.
        </p>
      </div>

      {enrollment ? (
        <Alert tone="warn">
          <strong>Primeiro acesso:</strong> o 2FA é obrigatório. No app autenticador, adicione uma conta
          com esta chave (entrada manual) e digite o código gerado:{" "}
          <code className="break-all font-bold">{enrollment.secret}</code>{" "}
          <a href={enrollment.otpauthUri} className="underline">
            abrir no app
          </a>
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="err" live className="font-semibold">
          {error}
        </Alert>
      ) : null}

      <div>
        <Label htmlFor="codigo">Código</Label>
        <Input
          id="codigo"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          placeholder="000000"
          value={code}
          invalid={Boolean(error)}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          className="text-center text-xl font-bold tracking-[0.4em]"
        />
      </div>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        disabled={pending || done}
        className="w-full"
      >
        {pending || done ? (
          <>
            <Spinner /> Entrando…
          </>
        ) : (
          "Entrar"
        )}
      </Button>
      <Button
        variant="ghost"
        disabled={pending || done}
        onClick={() =>
          startTransition(async () => {
            await cancelSignInAction();
            onRestart(null);
          })
        }
      >
        <Icon name="arrowLeft" size={18} />
        Usar outra conta
      </Button>
    </form>
  );
}
