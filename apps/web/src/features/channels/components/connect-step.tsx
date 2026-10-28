"use client";

import type { Channel, OfficialWebhookInfo, QrSession } from "@duckzap/contracts/channels";
import { Button } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert, Skeleton, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { CopyField } from "@/features/settings/components/copy-field";
import { FakeQr } from "@/features/settings/components/fake-qr";
import {
  authorizeInstagramAction,
  connectOfficialAction,
  getOfficialWebhookInfoAction,
  getQrStatusAction,
  startQrAction,
} from "../actions";

type ConnectTarget = Pick<Channel, "id" | "name" | "type">;

/** Passo "Conectar" (assistente de novo canal e reconexão). Chama `onConnected` quando o canal conecta. */
export function ConnectStep({ channel, onConnected }: { channel: ConnectTarget; onConnected: () => void }) {
  if (channel.type === "whatsapp_qr") return <QrConnect channelId={channel.id} onConnected={onConnected} />;
  if (channel.type === "whatsapp_official") return <OfficialConnect channelId={channel.id} onConnected={onConnected} />;
  return <InstagramConnect channelId={channel.id} onConnected={onConnected} />;
}

export function QrRiskWarning() {
  return (
    <Alert tone="warn" title="Conexão não oficial">
      O QR Code usa o WhatsApp Web, que a Meta não reconhece para empresas. Há risco de o número ser bloqueado, principalmente
      com envios em massa. Para volume alto ou campanhas, prefira a API oficial.
    </Alert>
  );
}

function formatCountdown(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function QrConnect({ channelId, onConnected }: { channelId: string; onConnected: () => void }) {
  const [session, setSession] = useState<QrSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const renewing = useRef(false);
  const connectedRef = useRef(onConnected);
  useEffect(() => {
    connectedRef.current = onConnected;
  }, [onConnected]);

  const renew = useCallback(async () => {
    if (renewing.current) return;
    renewing.current = true;
    const result = await startQrAction(channelId);
    renewing.current = false;
    if (result.ok) {
      setError(null);
      setSession(result.data);
      setNow(Date.now());
    } else setError(result.error);
  }, [channelId]);

  useEffect(() => {
    void renew();
  }, [renew]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const waiting = session?.status === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(async () => {
      const result = await getQrStatusAction(channelId);
      if (result.ok && result.data.status === "connected") {
        setSession(result.data);
        connectedRef.current();
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [waiting, channelId]);

  const remaining = session ? Math.max(0, Math.ceil((Date.parse(session.expiresAt) - now) / 1000)) : 0;
  useEffect(() => {
    if (waiting && remaining === 0) void renew();
  }, [waiting, remaining, renew]);

  if (error)
    return (
      <Alert tone="err" live action={<Button size="sm" onClick={() => void renew()}>Tentar de novo</Button>}>
        {error}
      </Alert>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-[22px]">
        {session ? (
          <FakeQr payload={session.payload} label="QR Code para conectar o WhatsApp" />
        ) : (
          <Skeleton className="size-50 rounded-xl" />
        )}
        <div className="flex flex-[1_1_200px] flex-col gap-2">
          <Chip tone="info" className="self-start">
            {session ? "Aguardando leitura" : "Gerando código…"}
          </Chip>
          <p className="font-bold">Abra o WhatsApp no celular</p>
          <p className="text-ink-2">
            Toque em Aparelhos conectados, depois em Conectar um aparelho e aponte a câmera para o código.
          </p>
          <p className="text-[13px] text-ink-2" aria-live="off">
            {session && remaining > 0
              ? `O código expira em ${formatCountdown(remaining)} e é renovado sozinho.`
              : "Renovando o código…"}
          </p>
        </div>
      </div>
      <p className="text-[13px] text-ink-2">
        <Icon name="alert" size={14} className="mr-1 inline align-[-2px]" />
        Conexão não oficial: risco de bloqueio do número em envios em massa.
      </p>
    </div>
  );
}

function OfficialConnect({ channelId, onConnected }: { channelId: string; onConnected: () => void }) {
  const [info, setInfo] = useState<OfficialWebhookInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let alive = true;
    void getOfficialWebhookInfoAction(channelId).then((result) => {
      if (alive && result.ok) setInfo(result.data);
    });
    return () => {
      alive = false;
    };
  }, [channelId]);

  function submit(formData: FormData) {
    const input = {
      phoneNumberId: String(formData.get("phoneNumberId") ?? ""),
      businessAccountId: String(formData.get("businessAccountId") ?? ""),
      accessToken: String(formData.get("accessToken") ?? ""),
    };
    startTransition(async () => {
      const result = await connectOfficialAction(channelId, input);
      if (result.ok) onConnected();
      else setError(result.error);
    });
  }

  return (
    <form action={submit} className="flex flex-col gap-3.5" noValidate>
      <p className="text-ink-2">
        Use os dados do seu app no painel da Meta (WhatsApp › Configuração da API). O token fica cifrado e não aparece de novo.
      </p>
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))]">
        <div>
          <Label htmlFor={`${channelId}-pnid`}>ID do número</Label>
          <Input id={`${channelId}-pnid`} name="phoneNumberId" inputMode="numeric" autoComplete="off" required className="h-10" />
        </div>
        <div>
          <Label htmlFor={`${channelId}-waba`}>ID da conta do WhatsApp Business</Label>
          <Input id={`${channelId}-waba`} name="businessAccountId" inputMode="numeric" autoComplete="off" required className="h-10" />
        </div>
      </div>
      <div>
        <Label htmlFor={`${channelId}-token`}>Token de acesso permanente</Label>
        <Input
          id={`${channelId}-token`}
          name="accessToken"
          type="password"
          autoComplete="off"
          required
          className="h-10"
          aria-describedby={error ? `${channelId}-erro` : undefined}
        />
        <FieldError id={`${channelId}-erro`} message={error ?? undefined} />
      </div>
      <div className="flex flex-col gap-3 rounded-control border border-line bg-bg p-3.5">
        <p className="text-[13px] font-semibold">No painel da Meta, em Webhooks, cole:</p>
        {info ? (
          <>
            <CopyField id={`${channelId}-wh`} label="URL do webhook" value={info.webhookUrl} mono />
            <CopyField id={`${channelId}-vt`} label="Token de verificação" value={info.verifyToken} mono />
          </>
        ) : (
          <Skeleton className="h-28 w-full" />
        )}
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? <Spinner size={16} /> : null}
          {pending ? "Verificando…" : "Conectar"}
        </Button>
      </div>
    </form>
  );
}

function InstagramConnect({ channelId, onConnected }: { channelId: string; onConnected: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-control bg-surface-2">
          <Icon name="instagram" size={22} />
        </span>
        <div>
          <p className="font-bold">Autorize o acesso à sua conta profissional</p>
          <p className="text-ink-2">
            Você entra com o Facebook e escolhe a Página ligada ao Instagram. Assim recebemos as DMs e os comentários na tela de
            Conversas.
          </p>
        </div>
      </div>
      {error ? (
        <Alert tone="err" live>
          {error}
        </Alert>
      ) : null}
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await authorizeInstagramAction(channelId);
              if (result.ok) onConnected();
              else setError(result.error);
            })
          }
        >
          {pending ? <Spinner size={16} /> : null}
          {pending ? "Aguardando o Facebook…" : "Autorizar com o Facebook"}
        </Button>
      </div>
    </div>
  );
}
