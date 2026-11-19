"use client";

import type { Account, NotificationPrefs, TwoFactorMethod } from "@duckzap/contracts/settings";
import { Button } from "@duckzap/ui/components/button";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { ConfirmDialog } from "@duckzap/ui/components/confirm-dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { emailError, phoneError } from "@duckzap/contracts/validation";
import { useState, useTransition } from "react";
import { EmailField, PhoneField } from "@/components/form-fields";
import { DATE_FORMATS, formatDate } from "@/lib/format";
import { disableTwoFactorAction, regenerateRecoveryCodesAction } from "@/features/security/actions";
import { MethodOptions, RecoveryCodesView, TwoFactorSetupFlow } from "@/features/security/components/two-factor-setup";
import { methodLabels, methodSignInHint, otherMethod } from "@/features/security/rules";
import { changePasswordAction, updateNotificationsAction, updateProfileAction } from "../actions";

type Feedback = { tone: "ok" | "err"; text: string } | null;

function FeedbackAlert({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <Alert tone={feedback.tone} live>
      {feedback.text}
    </Alert>
  );
}

function ProfileForm({ account }: { account: Account }) {
  const [form, setForm] = useState({ name: account.name, email: account.email, phone: account.phone });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [submitted, setSubmitted] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      // editar de novo apaga o aviso de "salvo"/erro da vez anterior
      onChange={() => setFeedback(null)}
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (emailError(form.email, { required: true }) || phoneError(form.phone)) {
          setFeedback({ tone: "err", text: "Corrija os campos destacados." });
          return;
        }
        startTransition(async () => {
          const result = await updateProfileAction(form);
          setFeedback(result.ok ? { tone: "ok", text: "Alterações salvas." } : { tone: "err", text: result.error });
        });
      }}
    >
      <CardTitle>Seus dados</CardTitle>
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr))]">
        <div>
          <Label htmlFor="conta-nome">Nome</Label>
          <Input id="conta-nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
        </div>
        <EmailField id="conta-email" label="E-mail" value={form.email} onChange={(v) => setForm({ ...form, email: v })} required showErrors={submitted} />
        <PhoneField id="conta-telefone" label="Telefone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} showErrors={submitted} />
      </div>
      <FeedbackAlert feedback={feedback} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </form>
  );
}

function PasswordForm() {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onChange={() => setFeedback(null)}
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        const input = {
          currentPassword: String(data.get("currentPassword") ?? ""),
          newPassword: String(data.get("newPassword") ?? ""),
          confirmPassword: String(data.get("confirmPassword") ?? ""),
        };
        startTransition(async () => {
          const result = await changePasswordAction(input);
          if (result.ok) form.reset();
          setFeedback(
            result.ok ? { tone: "ok", text: "Senha trocada. As outras sessões foram encerradas." } : { tone: "err", text: result.error },
          );
        });
      }}
    >
      <CardTitle>Senha</CardTitle>
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))]">
        <div>
          <Label htmlFor="senha-atual">Senha atual</Label>
          <Input id="senha-atual" name="currentPassword" type="password" autoComplete="current-password" />
        </div>
        <div>
          <Label htmlFor="senha-nova">Nova senha</Label>
          <Input id="senha-nova" name="newPassword" type="password" autoComplete="new-password" aria-describedby="senha-nova-dica" />
          <p id="senha-nova-dica" className="mt-1 text-xs text-ink-2">
            Pelo menos 10 caracteres.
          </p>
        </div>
        <div>
          <Label htmlFor="senha-confirma">Repita a nova senha</Label>
          <Input id="senha-confirma" name="confirmPassword" type="password" autoComplete="new-password" />
        </div>
      </div>
      <FeedbackAlert feedback={feedback} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Trocando…" : "Trocar senha"}
        </Button>
      </div>
    </form>
  );
}

type TwoFactorView =
  | { kind: "idle" }
  | { kind: "setup"; method: TwoFactorMethod }
  | { kind: "codes"; codes: string[]; title: string }
  | { kind: "regenerate" };

/**
 * Verificação em duas etapas: RECOMENDADA (obrigatória só se a empresa ligar a opção REQUIRE_2FA_FOR_ADMINS).
 * Dois métodos: app autenticador (recomendado) ou código por e-mail. Ativa: trocar de método, gerar novos códigos de
 * recuperação e desativar (menos quando é obrigatória).
 */
function TwoFactorSection({ account, timeZone }: { account: Account; timeZone: string }) {
  const { enabled, enabledAt, method } = account.twoFactor;
  const [view, setView] = useState<TwoFactorView>({ kind: "idle" });
  const [choice, setChoice] = useState<TwoFactorMethod>("app");
  const [notice, setNotice] = useState<string | null>(null);
  // o Better Auth pede a senha para desligar e para gerar novos códigos de recuperação
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function openRegenerate() {
    setPassword("");
    setError(null);
    setView({ kind: "regenerate" });
  }

  function enabledWith(codes: string[] | null, target: TwoFactorMethod) {
    setNotice(null);
    if (codes) setView({ kind: "codes", codes, title: enabled ? "Método trocado!" : "Ativada!" });
    else {
      setView({ kind: "idle" });
      setNotice(`Pronto: agora você usa ${methodLabels[target].toLowerCase()}. Seus códigos de recuperação continuam os mesmos.`);
    }
  }

  return (
    <section aria-labelledby="dois-fatores-titulo" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle id="dois-fatores-titulo">Verificação em duas etapas</CardTitle>
        {enabled ? (
          <Chip tone="ok">Ativa{method ? ` · ${methodLabels[method]}` : ""}</Chip>
        ) : account.twoFactorRequired ? (
          <Chip tone="err">Obrigatória</Chip>
        ) : (
          <Chip>Recomendada</Chip>
        )}
      </div>

      {notice ? (
        <Alert tone="ok" live>
          {notice}
        </Alert>
      ) : null}

      {view.kind === "codes" ? (
        <RecoveryCodesView codes={view.codes} title={view.title} onDone={() => setView({ kind: "idle" })} />
      ) : view.kind === "setup" ? (
        <div className="flex flex-col gap-3">
          <p className="font-semibold">{enabled ? `Trocar para ${methodLabels[view.method].toLowerCase()}` : methodLabels[view.method]}</p>
          {enabled && view.method === "app" ? (
            <p className="text-[13px] text-ink-2">Ao trocar para o app, você recebe códigos de recuperação novos.</p>
          ) : null}
          <TwoFactorSetupFlow
            method={view.method}
            onEnabled={(codes) => enabledWith(codes, view.method)}
            onCancel={() => setView({ kind: "idle" })}
          />
        </div>
      ) : view.kind === "regenerate" ? (
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            startTransition(async () => {
              const result = await regenerateRecoveryCodesAction(password);
              if (!result.ok) return setError(result.error);
              setPassword("");
              setView({ kind: "codes", codes: result.data.recoveryCodes, title: "Códigos novos gerados." });
            });
          }}
        >
          <p className="text-ink-2">Os códigos de recuperação antigos deixam de funcionar.</p>
          {error ? (
            <Alert tone="err" live>
              {error}
            </Alert>
          ) : null}
          <div className="max-w-72">
            <Label htmlFor="dois-fatores-senha-codigos">Confirme sua senha</Label>
            <Input
              id="dois-fatores-senha-codigos"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={pending || password.length === 0}>
              {pending ? "Gerando…" : "Gerar novos códigos"}
            </Button>
            <Button onClick={() => setView({ kind: "idle" })} disabled={pending}>
              Cancelar
            </Button>
          </div>
        </form>
      ) : enabled && method ? (
        <>
          <p className="text-ink-2">
            Ativa{enabledAt ? ` desde ${formatDate(enabledAt, DATE_FORMATS.day, timeZone)}` : ""}. {methodSignInHint[method]}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setView({ kind: "setup", method: otherMethod(method) })}>
              {method === "app" ? "Trocar para código por e-mail" : "Trocar para app autenticador (recomendado)"}
            </Button>
            <Button size="sm" onClick={openRegenerate}>
              Gerar novos códigos de recuperação
            </Button>
            {account.twoFactorRequired ? null : (
              <ConfirmDialog
                trigger={<Button size="sm" variant="danger-ghost">Desativar</Button>}
                title="Desativar a verificação em duas etapas?"
                description="Sua conta fica protegida só pela senha."
                confirmLabel="Desativar"
                pendingLabel="Desativando…"
                danger
                onConfirm={() => disableTwoFactorAction(password)}
              >
                <div>
                  <Label htmlFor="dois-fatores-senha-desativar">Confirme sua senha</Label>
                  <Input
                    id="dois-fatores-senha-desativar"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </ConfirmDialog>
            )}
          </div>
          {account.twoFactorRequired ? (
            <p className="text-[13px] text-ink-2">
              Sua empresa exige a verificação para Proprietário e Administrador: dá para trocar de método, mas não desativar.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-ink-2">Proteja sua conta com um código além da senha. Recomendamos o app autenticador.</p>
          {account.twoFactorRequired ? (
            <Alert tone="warn">Seu papel exige a verificação em duas etapas. Ative agora para não perder o acesso.</Alert>
          ) : null}
          <MethodOptions value={choice} onChange={setChoice} />
          <Button variant="primary" className="self-start" onClick={() => setView({ kind: "setup", method: choice })}>
            Ativar verificação em duas etapas
          </Button>
        </>
      )}
    </section>
  );
}

function PreferencesForm({ notifications }: { notifications: NotificationPrefs }) {
  const [prefs, setPrefs] = useState(notifications);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, startTransition] = useTransition();

  async function toggleBrowser(on: boolean) {
    // avisos do navegador precisam da permissão do próprio navegador
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setFeedback({ tone: "err", text: "O navegador bloqueou os avisos. Libere nas configurações do site." });
        return;
      }
    }
    setPrefs((p) => ({ ...p, browser: on }));
  }

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onChange={() => setFeedback(null)}
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await updateNotificationsAction(prefs);
          setFeedback(result.ok ? { tone: "ok", text: "Alterações salvas." } : { tone: "err", text: result.error });
        });
      }}
    >
      <fieldset>
        <legend className="mb-1.5 text-base font-bold">Notificações</legend>
        <label className="flex min-h-11 items-center gap-2.5">
          <Checkbox checked={prefs.sound} onChange={(e) => setPrefs({ ...prefs, sound: e.target.checked })} />
          Som ao chegar nova mensagem
        </label>
        <label className="flex min-h-11 items-center gap-2.5">
          <Checkbox checked={prefs.browser} onChange={(e) => void toggleBrowser(e.target.checked)} />
          Avisos no navegador
        </label>
        <label className="flex min-h-11 items-center gap-2.5">
          <Checkbox checked={prefs.emailSummary} onChange={(e) => setPrefs({ ...prefs, emailSummary: e.target.checked })} />
          Resumo diário por e-mail
        </label>
      </fieldset>
      <FeedbackAlert feedback={feedback} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </form>
  );
}

export function AccountPanel({ account, timeZone }: { account: Account; timeZone: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <Card padding="lg">
            <ProfileForm account={account} />
          </Card>
          <Card padding="lg">
            <PasswordForm />
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Card padding="lg">
            <TwoFactorSection account={account} timeZone={timeZone} />
          </Card>
          <Card padding="lg">
            <PreferencesForm notifications={account.notifications} />
          </Card>
        </div>
      </div>
    </div>
  );
}
