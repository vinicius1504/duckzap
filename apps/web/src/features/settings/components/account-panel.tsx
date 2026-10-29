"use client";

import type { Account, NotificationPrefs, TwoFactorSetup } from "@duckzap/contracts/settings";
import { Button } from "@duckzap/ui/components/button";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { Segmented } from "@duckzap/ui/components/segmented";
import { useTheme, type ThemePreference } from "@duckzap/ui/theme";
import { useState, useTransition } from "react";
import { formatDate } from "@/lib/format";
import {
  changePasswordAction,
  confirmTwoFactorAction,
  disableTwoFactorAction,
  startTwoFactorAction,
  updateNotificationsAction,
  updateProfileAction,
} from "../actions";
import { ConfirmDialog } from "./confirm-dialog";
import { CopyField } from "./copy-field";
import { FakeQr } from "./fake-qr";

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
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await updateProfileAction(form);
          setFeedback(result.ok ? { tone: "ok", text: "Dados salvos." } : { tone: "err", text: result.error });
        });
      }}
    >
      <CardTitle>Seus dados</CardTitle>
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr))]">
        <div>
          <Label htmlFor="conta-nome">Nome</Label>
          <Input id="conta-nome" className="h-10" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
        </div>
        <div>
          <Label htmlFor="conta-email">E-mail</Label>
          <Input id="conta-email" type="email" className="h-10" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
        </div>
        <div>
          <Label htmlFor="conta-telefone">Telefone</Label>
          <Input id="conta-telefone" type="tel" className="h-10" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" />
        </div>
      </div>
      <FeedbackAlert feedback={feedback} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Salvando…" : "Salvar alterações"}
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
          <Input id="senha-atual" name="currentPassword" type="password" className="h-10" autoComplete="current-password" />
        </div>
        <div>
          <Label htmlFor="senha-nova">Nova senha</Label>
          <Input id="senha-nova" name="newPassword" type="password" className="h-10" autoComplete="new-password" aria-describedby="senha-nova-dica" />
          <p id="senha-nova-dica" className="mt-1 text-xs text-ink-2">
            Pelo menos 10 caracteres.
          </p>
        </div>
        <div>
          <Label htmlFor="senha-confirma">Repita a nova senha</Label>
          <Input id="senha-confirma" name="confirmPassword" type="password" className="h-10" autoComplete="new-password" />
        </div>
      </div>
      <FeedbackAlert feedback={feedback} />
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Trocando…" : "Trocar senha"}
        </Button>
      </div>
    </form>
  );
}

function TwoFactorSection({ account, timeZone }: { account: Account; timeZone: string }) {
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  // o Better Auth pede a senha para ligar e para desligar a verificação em duas etapas
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { enabled, enabledAt } = account.twoFactor;

  return (
    <section aria-labelledby="dois-fatores-titulo" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle id="dois-fatores-titulo">Verificação em duas etapas</CardTitle>
        {enabled ? <Chip tone="ok">Ativa</Chip> : account.twoFactorRequired ? <Chip tone="err">Obrigatória</Chip> : <Chip>Desativada</Chip>}
      </div>

      {recoveryCodes ? (
        <div className="flex flex-col gap-3">
          <Alert tone="ok" live title="Ativada!">
            Guarde estes códigos de recuperação. Cada um funciona uma vez se você perder o celular. Não mostramos de novo.
          </Alert>
          <ul className="grid grid-cols-2 gap-2 rounded-control border border-line bg-bg p-3 font-mono text-[13px] max-[360px]:grid-cols-1">
            {recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <CopyField id="codigos-recuperacao" label="Todos os códigos" value={recoveryCodes.join(" ")} mono />
          <Button className="self-start" onClick={() => setRecoveryCodes(null)}>
            Já guardei
          </Button>
        </div>
      ) : enabled ? (
        <>
          <p className="text-ink-2">
            Ativa desde {enabledAt ? formatDate(enabledAt, { day: "2-digit", month: "2-digit", year: "numeric" }, timeZone) : "—"}. Ao entrar,
            pedimos o código do app autenticador.
          </p>
          {account.twoFactorRequired ? (
            <p className="text-[13px] text-ink-2">Obrigatória para Proprietário e Administrador, por isso não pode ser desativada.</p>
          ) : (
            <ConfirmDialog
              trigger={<Button size="sm" className="self-start">Desativar</Button>}
              title="Desativar a verificação em duas etapas?"
              description="Sua conta fica protegida só pela senha."
              confirmLabel="Desativar"
              danger
              onConfirm={() => disableTwoFactorAction(password)}
            >
              <div>
                <Label htmlFor="dois-fatores-senha-desativar">Confirme sua senha</Label>
                <Input
                  id="dois-fatores-senha-desativar"
                  type="password"
                  autoComplete="current-password"
                  className="h-10"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </ConfirmDialog>
          )}
        </>
      ) : setup ? (
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const result = await confirmTwoFactorAction(code);
              if (result.ok) {
                setSetup(null);
                setCode("");
                setError(null);
                setRecoveryCodes(result.data.recoveryCodes);
              } else setError(result.error);
            });
          }}
        >
          <div className="flex flex-wrap items-center gap-5">
            <FakeQr payload={setup.otpauthUrl} label="QR Code para o app autenticador" size={168} />
            <ol className="flex flex-[1_1_220px] list-decimal flex-col gap-1.5 pl-5 text-ink-2">
              <li>Abra um app autenticador (Google Authenticator, Microsoft Authenticator, 1Password…).</li>
              <li>Leia o QR Code ou digite a chave abaixo.</li>
              <li>Informe o código de 6 números que aparece no app.</li>
            </ol>
          </div>
          <CopyField id="totp-chave" label="Chave para digitar" value={setup.secret} mono />
          <div className="max-w-60">
            <Label htmlFor="totp-codigo">Código do app</Label>
            <Input
              id="totp-codigo"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-10 font-mono tracking-widest"
              aria-describedby={error ? "totp-erro" : undefined}
              invalid={Boolean(error)}
            />
            <FieldError id="totp-erro" message={error ?? undefined} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Conferindo…" : "Ativar"}
            </Button>
            <Button onClick={() => setSetup(null)}>Cancelar</Button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-ink-2">Proteja sua conta com um código do celular além da senha.</p>
          {account.twoFactorRequired ? (
            <Alert tone="warn">Seu papel exige a verificação em duas etapas. Ative agora para não perder o acesso.</Alert>
          ) : null}
          {error ? (
            <Alert tone="err" live>
              {error}
            </Alert>
          ) : null}
          <div className="max-w-60">
            <Label htmlFor="dois-fatores-senha">Confirme sua senha</Label>
            <Input
              id="dois-fatores-senha"
              type="password"
              autoComplete="current-password"
              className="h-10"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button
            variant="primary"
            className="self-start"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await startTwoFactorAction(password);
                if (result.ok) {
                  setError(null);
                  setPassword("");
                  setSetup(result.data);
                } else setError(result.error);
              })
            }
          >
            Ativar verificação em duas etapas
          </Button>
        </>
      )}
    </section>
  );
}

const themeOptions = [
  { value: "light", label: "Claro" },
  { value: "dark", label: "Escuro" },
  { value: "system", label: "Automático" },
] as const satisfies readonly { value: ThemePreference; label: string }[];

/** Tema: muda na hora e fica salvo no navegador, então não tem botão de salvar. */
function ThemeSection() {
  const { theme, setTheme } = useTheme();
  return (
    <section aria-labelledby="tema-titulo" className="flex flex-col gap-3">
      <CardTitle id="tema-titulo">Tema</CardTitle>
      <Segmented label="Tema" options={themeOptions} value={theme} onChange={setTheme} />
      <p className="text-xs text-ink-2">Muda na hora e fica salvo neste navegador. Automático segue o sistema.</p>
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
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await updateNotificationsAction(prefs);
          setFeedback(result.ok ? { tone: "ok", text: "Preferências salvas." } : { tone: "err", text: result.error });
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
          {pending ? "Salvando…" : "Salvar preferências"}
        </Button>
      </div>
    </form>
  );
}

export function AccountPanel({ account, timeZone }: { account: Account; timeZone: string }) {
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-6 max-sm:p-4">
        <ProfileForm account={account} />
      </Card>
      <Card className="p-6 max-sm:p-4">
        <PasswordForm />
      </Card>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card className="p-6 max-sm:p-4">
          <TwoFactorSection account={account} timeZone={timeZone} />
        </Card>
        <Card className="p-6 max-sm:p-4">
          <ThemeSection />
        </Card>
      </div>
      <Card className="p-6 max-sm:p-4">
        <PreferencesForm notifications={account.notifications} />
      </Card>
    </div>
  );
}
