"use client";

import {
  officialApiSchema,
  type ConnectionMethod,
  type OfficialApiInput,
  type OnboardingDraft,
  type QrSession,
} from "@duckzap/contracts/onboarding";
import { brand } from "@duckzap/brand";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { cn } from "@duckzap/ui/cn";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { formatPhone } from "@/lib/format";
import {
  checkQrAction,
  connectOfficialApiAction,
  skipWhatsappAction,
  startQrAction,
} from "../actions";
import { FakeQr } from "./fake-qr";

const POLL_MS = 2500;

const methods: { value: ConnectionMethod; title: string; detail: string; icon: "qr" | "key" }[] = [
  {
    value: "qr_code",
    title: "QR Code",
    detail: "Mais rápido. Use o WhatsApp que já está no seu celular.",
    icon: "qr",
  },
  {
    value: "official_api",
    title: "API oficial da Meta",
    detail: "Mais estável para volumes altos. Pede alguns dados da Meta.",
    icon: "key",
  },
];

export function WhatsappStep({ whatsapp }: { whatsapp: OnboardingDraft["whatsapp"] }) {
  const router = useRouter();
  const [method, setMethod] = useState<ConnectionMethod>(whatsapp?.method ?? "qr_code");
  const [connectedPhone, setConnectedPhone] = useState<string | null>(
    whatsapp?.status === "connected" ? whatsapp.phone : null,
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function skip() {
    setError(null);
    startTransition(async () => {
      const result = await skipWhatsappAction();
      if (result) {
        setError(result.error);
        return;
      }
      router.push("/comecar?passo=agente");
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">
          Conecte o seu WhatsApp
        </h1>
        <p className="mt-1.5 text-ink-2">
          Leva cerca de um minuto. Você pode usar o número que já tem hoje.
        </p>
      </div>

      {error ? (
        <Alert tone="err" live>
          {error}
        </Alert>
      ) : null}

      <Card className="flex flex-wrap items-start gap-8 p-7 max-sm:p-4">
        <fieldset className="flex min-w-0 flex-[1_1_300px] flex-col gap-3">
          <legend className="sr-only">Como conectar</legend>
          {methods.map((m) => (
            <label
              key={m.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border-2 border-line bg-surface p-3.5",
                method === m.value && "border-ink bg-warn-bg/40",
                connectedPhone && "cursor-default",
              )}
            >
              <input
                type="radio"
                name="metodo"
                value={m.value}
                checked={method === m.value}
                disabled={Boolean(connectedPhone)}
                onChange={() => setMethod(m.value)}
                className="mt-1 size-[18px] shrink-0 accent-ink"
              />
              <span>
                <strong className="flex items-center gap-2">
                  <Icon name={m.icon} size={18} /> {m.title}
                </strong>
                <span className="text-ink-2">{m.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="min-w-0 flex-[1_1_320px]">
          {connectedPhone ? (
            <Connected phone={connectedPhone} />
          ) : method === "qr_code" ? (
            <QrPanel onConnected={setConnectedPhone} />
          ) : (
            <OfficialApiForm onConnected={setConnectedPhone} />
          )}
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button size="lg" onClick={() => router.push("/comecar?passo=empresa")} disabled={pending}>
          Voltar
        </Button>
        <div className="flex flex-wrap gap-3">
          {connectedPhone ? null : (
            <Button size="lg" onClick={skip} disabled={pending}>
              {pending ? <Spinner /> : null}
              Conectar depois
            </Button>
          )}
          <Button
            size="lg"
            variant="primary"
            disabled={!connectedPhone || pending}
            aria-describedby={connectedPhone ? undefined : "continuar-dica"}
            onClick={() => router.push("/comecar?passo=agente")}
          >
            Continuar
          </Button>
        </div>
        {connectedPhone ? null : (
          <p id="continuar-dica" className="w-full text-right text-[13px] text-ink-2">
            Conecte um número para continuar, ou deixe para depois.
          </p>
        )}
      </div>
    </div>
  );
}

function Connected({ phone }: { phone: string }) {
  return (
    <div role="status" className="flex flex-col items-start gap-3">
      <span className="flex size-12 items-center justify-center rounded-full bg-ok-bg text-ok">
        <Icon name="check" size={26} strokeWidth={2.4} />
      </span>
      <Chip tone="ok">
        <span className="size-2 rounded-full bg-current" aria-hidden="true" />
        WhatsApp conectado
      </Chip>
      <p className="text-lg font-bold">{formatPhone(phone)}</p>
      <p className="text-ink-2">
        Pronto! As mensagens desse número já chegam no {brand.name}. Continue para criar o agente.
      </p>
    </div>
  );
}

function secondsLeft(iso: string) {
  return Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
}

function QrPanel({ onConnected }: { onConnected: (phone: string) => void }) {
  const [session, setSession] = useState<QrSession | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const started = useRef(false);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await startQrAction();
    setLoading(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setSession(result.session);
    setLeft(secondsLeft(result.session.expiresAt));
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void generate();
  }, [generate]);

  // contagem regressiva + consulta do status enquanto aguarda a leitura
  useEffect(() => {
    if (!session || session.status !== "pending") return;
    const tick = setInterval(() => setLeft(secondsLeft(session.expiresAt)), 1000);
    const poll = setInterval(async () => {
      const result = await checkQrAction(session.id);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSession(result.session);
      if (result.session.status === "connected" && result.session.phone)
        onConnected(result.session.phone);
    }, POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [session, onConnected]);

  const expired = session?.status === "expired" || (session?.status === "pending" && left === 0);
  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, "0");

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative flex size-[206px] shrink-0 items-center justify-center rounded-card border border-line bg-surface">
        {loading || !session ? (
          <Spinner size={28} />
        ) : (
          <FakeQr payload={session.payload} faded={expired} />
        )}
      </div>
      <div className="flex min-w-0 flex-[1_1_180px] flex-col items-start gap-2.5">
        {error ? (
          <Alert tone="err" live>
            {error}
          </Alert>
        ) : null}
        {expired ? (
          <Chip tone="warn">Código expirado</Chip>
        ) : (
          <Chip tone="info">Aguardando leitura</Chip>
        )}
        <p className="text-ink-2">
          No celular: WhatsApp › Aparelhos conectados › Conectar um aparelho.
        </p>
        {session && !expired ? (
          <p className="text-[13px] text-ink-2" aria-live="off">
            Expira em {minutes}:{seconds}
          </p>
        ) : null}
        <Button size="sm" onClick={() => void generate()} disabled={loading}>
          <Icon name="refresh" size={16} />
          Gerar novo código
        </Button>
      </div>
    </div>
  );
}

function OfficialApiForm({ onConnected }: { onConnected: (phone: string) => void }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<OfficialApiInput>({
    resolver: zodResolver(officialApiSchema),
    defaultValues: { phoneNumberId: "", businessAccountId: "", accessToken: "" },
  });

  async function onSubmit(values: OfficialApiInput) {
    setServerError(null);
    const result = await connectOfficialApiAction(values);
    if ("error" in result) {
      setServerError(result.error);
      return;
    }
    onConnected(result.phone);
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <p className="text-ink-2">
        Pegue estes dados no painel da Meta (WhatsApp › Configuração da API). O token fica guardado
        cifrado e nunca aparece de novo.
      </p>
      {serverError ? (
        <Alert tone="err" live>
          {serverError}
        </Alert>
      ) : null}
      <div>
        <Label htmlFor="meta-numero">ID do número de telefone</Label>
        <Input
          id="meta-numero"
          inputMode="numeric"
          autoComplete="off"
          invalid={Boolean(errors.phoneNumberId)}
          aria-describedby={errors.phoneNumberId ? "meta-numero-erro" : undefined}
          {...register("phoneNumberId")}
        />
        <FieldError id="meta-numero-erro" message={errors.phoneNumberId?.message} />
      </div>
      <div>
        <Label htmlFor="meta-conta">ID da conta do WhatsApp Business</Label>
        <Input
          id="meta-conta"
          inputMode="numeric"
          autoComplete="off"
          invalid={Boolean(errors.businessAccountId)}
          aria-describedby={errors.businessAccountId ? "meta-conta-erro" : undefined}
          {...register("businessAccountId")}
        />
        <FieldError id="meta-conta-erro" message={errors.businessAccountId?.message} />
      </div>
      <div>
        <Label htmlFor="meta-token">Token de acesso permanente</Label>
        <Input
          id="meta-token"
          type="password"
          autoComplete="off"
          invalid={Boolean(errors.accessToken)}
          aria-describedby={errors.accessToken ? "meta-token-erro" : undefined}
          {...register("accessToken")}
        />
        <FieldError id="meta-token-erro" message={errors.accessToken?.message} />
      </div>
      <Button type="submit" variant="primary" disabled={isSubmitting} className="self-start">
        {isSubmitting ? <Spinner /> : null}
        {isSubmitting ? "Conectando…" : "Conectar"}
      </Button>
    </form>
  );
}
