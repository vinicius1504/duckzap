"use client";

import type { TwoFactorMethod, TwoFactorSetup } from "@duckzap/contracts/settings";
import { Button } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { cn } from "@duckzap/ui/cn";
import { useState, useTransition } from "react";
import { CopyField } from "@/features/settings/components/copy-field";
import { FakeQr } from "@/features/settings/components/fake-qr";
import { confirmAppSetupAction, confirmEmailSetupAction, startAppSetupAction, startEmailSetupAction } from "../actions";

// Peças da verificação em duas etapas usadas no cadastro ("Proteja sua conta") e em Ajustes › Minha conta.
// O app autenticador é o RECOMENDADO (funciona sem internet e não depende do e-mail); o código por e-mail é a alternativa.

const methodOptions: { value: TwoFactorMethod; title: string; detail: string; icon: "shield" | "mail"; recommended?: boolean }[] = [
  {
    value: "app",
    title: "Usar app autenticador",
    detail: "Google Authenticator ou outro app, como o Microsoft Authenticator. Funciona até sem internet.",
    icon: "shield",
    recommended: true,
  },
  {
    value: "email",
    title: "Receber código por e-mail",
    detail: "Enviamos um código para o seu e-mail sempre que você entrar.",
    icon: "mail",
  },
];

/** Escolha do método (app recomendado). */
export function MethodOptions({
  value,
  onChange,
  name = "metodo-2fa",
}: {
  value: TwoFactorMethod;
  onChange: (method: TwoFactorMethod) => void;
  name?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="sr-only">Como receber o código</legend>
      {methodOptions.map((m) => (
        <label
          key={m.value}
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-xl border-2 border-line bg-surface p-3.5",
            value === m.value && "border-ink bg-warn-bg/40",
          )}
        >
          <input
            type="radio"
            name={name}
            value={m.value}
            checked={value === m.value}
            onChange={() => onChange(m.value)}
            className="mt-1 size-[18px] shrink-0 accent-ink"
          />
          <span className="min-w-0">
            <strong className="flex flex-wrap items-center gap-2">
              <Icon name={m.icon} size={18} /> {m.title}
              {m.recommended ? <Chip tone="ok">Recomendado</Chip> : null}
            </strong>
            <span className="text-ink-2">{m.detail}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Códigos de recuperação, mostrados UMA vez logo depois de ativar (ou de gerar novos). */
export function RecoveryCodesView({
  codes,
  title = "Ativada!",
  doneLabel = "Já guardei",
  onDone,
}: {
  codes: string[];
  title?: string;
  doneLabel?: string;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="ok" live title={title}>
        Guarde estes códigos de recuperação num lugar seguro. Cada um funciona uma vez se você perder o celular ou o acesso ao
        e-mail. Não mostramos de novo.
      </Alert>
      <ul className="grid grid-cols-2 gap-2 rounded-control border border-line bg-bg p-3 font-mono text-[13px] max-[360px]:grid-cols-1">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <CopyField id="codigos-recuperacao" label="Todos os códigos" value={codes.join(" ")} mono />
      <Button variant="primary" className="self-start" onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}

function CodeField({
  id,
  label,
  code,
  onChange,
  error,
}: {
  id: string;
  label: string;
  code: string;
  onChange: (code: string) => void;
  error: string | null;
}) {
  return (
    <div className="max-w-60">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        value={code}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono tracking-widest"
        aria-describedby={error ? `${id}-erro` : undefined}
        invalid={Boolean(error)}
      />
      <FieldError id={`${id}-erro`} message={error ?? undefined} />
    </div>
  );
}

type Stage = { kind: "password" } | { kind: "app"; setup: TwoFactorSetup } | { kind: "email"; sentTo: string };

/**
 * Ativar (ou trocar para) um método: senha → QR Code e código do app, ou senha → código enviado por e-mail.
 * O Better Auth pede a senha de novo para mexer no 2FA; ela só fica na memória da tela até terminar (reenviar o e-mail).
 * `onEnabled(códigos)`: ativou; `null` = os códigos de recuperação continuam os mesmos (trocou do app para o e-mail).
 */
export function TwoFactorSetupFlow({
  method,
  passwordLabel = "Confirme sua senha",
  passwordHint,
  submitLabel,
  onEnabled,
  onCancel,
  cancelLabel = "Cancelar",
}: {
  method: TwoFactorMethod;
  passwordLabel?: string;
  passwordHint?: string;
  submitLabel?: string;
  onEnabled: (recoveryCodes: string[] | null) => void;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "password" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function start() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      if (method === "app") {
        const result = await startAppSetupAction(password);
        if (result.ok) setStage({ kind: "app", setup: result.data });
        else setError(result.error);
        return;
      }
      const result = await startEmailSetupAction(password);
      if (result.ok) {
        setStage({ kind: "email", sentTo: result.data.email });
        setCode("");
      } else setError(result.error);
    });
  }

  function resend() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await startEmailSetupAction(password);
      if (result.ok) setNotice("Enviamos um código novo. Use o mais recente.");
      else setError(result.error);
    });
  }

  function confirm() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = method === "app" ? await confirmAppSetupAction(code) : await confirmEmailSetupAction(code);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPassword("");
      onEnabled(result.data.recoveryCodes);
    });
  }

  if (stage.kind === "password") {
    return (
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        {error ? (
          <Alert tone="err" live>
            {error}
          </Alert>
        ) : null}
        <div className="max-w-72">
          <Label htmlFor={`dois-fatores-senha-${method}`}>{passwordLabel}</Label>
          <Input
            id={`dois-fatores-senha-${method}`}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={passwordHint ? `dois-fatores-senha-${method}-dica` : undefined}
          />
          {passwordHint ? (
            <p id={`dois-fatores-senha-${method}-dica`} className="mt-1 text-xs text-ink-2">
              {passwordHint}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={pending || password.length === 0}>
            {pending ? <Spinner size={16} /> : null}
            {submitLabel ?? (method === "app" ? "Mostrar QR Code" : "Enviar código")}
          </Button>
          {onCancel ? (
            <Button onClick={onCancel} disabled={pending}>
              {cancelLabel}
            </Button>
          ) : null}
        </div>
      </form>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        confirm();
      }}
    >
      {stage.kind === "app" ? (
        <>
          <div className="flex flex-wrap items-center gap-5">
            <FakeQr payload={stage.setup.otpauthUrl} label="QR Code para o app autenticador" size={168} />
            <ol className="flex flex-[1_1_220px] list-decimal flex-col gap-1.5 pl-5 text-ink-2">
              <li>
                Instale o <strong className="text-ink">Google Authenticator</strong> no celular (ou outro app autenticador,
                como o Microsoft Authenticator).
              </li>
              <li>No app, toque em + e leia o QR Code. Se preferir, digite a chave abaixo.</li>
              <li>Digite o código de 6 números que aparece no app.</li>
            </ol>
          </div>
          <CopyField id="totp-chave" label="Chave para digitar" value={stage.setup.secret} mono />
          <CodeField id="totp-codigo" label="Código do app" code={code} onChange={setCode} error={error} />
        </>
      ) : (
        <>
          <p className="text-ink-2">
            Enviamos um código de 6 números para <strong className="text-ink">{stage.sentTo}</strong>. Ele vale por 5 minutos.
            Não chegou? Confira a caixa de spam.
          </p>
          {notice ? (
            <Alert tone="ok" live>
              {notice}
            </Alert>
          ) : null}
          <CodeField id="email-codigo" label="Código do e-mail" code={code} onChange={setCode} error={error} />
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={pending || code.trim().length < 6}>
          {pending ? <Spinner size={16} /> : null}
          {pending ? "Conferindo…" : "Ativar"}
        </Button>
        {stage.kind === "email" ? (
          <Button onClick={resend} disabled={pending}>
            Reenviar código
          </Button>
        ) : null}
        {onCancel ? (
          <Button onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
