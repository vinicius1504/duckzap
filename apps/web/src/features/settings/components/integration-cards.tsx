"use client";

import type { Integrations, IntegrationStatus } from "@duckzap/contracts/settings";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip, type ChipTone } from "@duckzap/ui/components/chip";
import { Alert } from "@duckzap/ui/components/feedback";
import { Input, Label } from "@duckzap/ui/components/input";
import Link from "next/link";
import { useState, useTransition } from "react";
import { formatDate } from "@/lib/format";
import {
  authorizeInstagramAction,
  connectGoogleCalendarAction,
  disconnectGoogleCalendarAction,
  updateWhatsappTokenAction,
} from "../actions";
import { ConfirmDialog } from "./confirm-dialog";
import { CopyField } from "./copy-field";

const statusView: Record<IntegrationStatus, { label: string; tone: ChipTone }> = {
  connected: { label: "Conectado", tone: "ok" },
  awaiting_authorization: { label: "Aguardando autorização", tone: "warn" },
  disconnected: { label: "Desconectado", tone: "neutral" },
  error: { label: "Com problema", tone: "err" },
};

function Header({ title, status }: { title: string; status: IntegrationStatus }) {
  const view = statusView[status];
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-bold">{title}</h3>
      <Chip tone={view.tone}>{view.label}</Chip>
    </div>
  );
}

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: true } | { ok?: false; error: string }>) =>
    startTransition(async () => {
      const result = await fn();
      setError(result.ok ? null : result.error);
    });
  return { error, pending, run };
}

export function IntegrationCards({ integrations, timeZone }: { integrations: Integrations; timeZone: string }) {
  const { googleCalendar, instagram, whatsappOfficial } = integrations;
  const google = useAction();
  const insta = useAction();
  const [token, setToken] = useState("");
  const [tokenFeedback, setTokenFeedback] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [savingToken, startSavingToken] = useTransition();

  return (
    <>
      <Card className="flex flex-col gap-2.5 p-5 max-sm:p-4">
        <Header title="Google Calendar" status={googleCalendar.status} />
        <p className="text-[13px] text-ink-2">
          {googleCalendar.status === "connected" && googleCalendar.lastSyncAt
            ? `Calendário “${googleCalendar.calendarName}” sincronizado em ${formatDate(
                googleCalendar.lastSyncAt,
                { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" },
                timeZone,
              )}.`
            : "Sincronize a Agenda com o Google Calendar nos dois sentidos."}
        </p>
        {google.error ? (
          <Alert tone="err" live>
            {google.error}
          </Alert>
        ) : null}
        {googleCalendar.status === "connected" ? (
          <ConfirmDialog
            trigger={<Button size="sm" className="self-start">Desconectar</Button>}
            title="Desconectar o Google Calendar?"
            description="Os agendamentos param de sincronizar. Os que já estão no Google continuam lá."
            confirmLabel="Desconectar"
            danger
            onConfirm={disconnectGoogleCalendarAction}
          />
        ) : (
          <Button size="sm" variant="primary" className="self-start" disabled={google.pending} onClick={() => google.run(connectGoogleCalendarAction)}>
            {google.pending ? "Conectando…" : "Conectar com o Google"}
          </Button>
        )}
      </Card>

      <Card className="flex flex-col gap-2.5 p-5 max-sm:p-4">
        <Header title="Instagram" status={instagram.status} />
        <p className="text-[13px] text-ink-2">
          {instagram.status === "connected" ? `Conta ${instagram.account} recebendo DMs e comentários.` : "Receba DMs e comentários na tela de Conversas."}
        </p>
        {insta.error ? (
          <Alert tone="err" live>
            {insta.error}
          </Alert>
        ) : null}
        {instagram.status === "connected" ? (
          <Link href="/canais" className="self-start text-[13px] font-semibold underline">
            Gerenciar em Canais
          </Link>
        ) : (
          <Button size="sm" variant="primary" className="self-start" disabled={insta.pending} onClick={() => insta.run(authorizeInstagramAction)}>
            {insta.pending ? "Aguardando o Facebook…" : "Autorizar"}
          </Button>
        )}
      </Card>

      <Card className="col-span-full flex flex-col gap-3 p-5 max-sm:p-4">
        <Header title="WhatsApp API oficial" status={whatsappOfficial.status} />
        <form
          className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))]"
          onSubmit={(e) => {
            e.preventDefault();
            startSavingToken(async () => {
              const result = await updateWhatsappTokenAction(token);
              setTokenFeedback(result.ok ? { tone: "ok", text: "Token atualizado." } : { tone: "err", text: result.error });
              if (result.ok) setToken("");
            });
          }}
        >
          <div>
            <Label htmlFor="wa-numero">ID do número</Label>
            <Input
              id="wa-numero"
              readOnly
              className="h-10"
              value={whatsappOfficial.phoneNumberIdLast4 ? `•••••••••••${whatsappOfficial.phoneNumberIdLast4}` : "Não configurado"}
            />
          </div>
          <div>
            <Label htmlFor="wa-token">Token de acesso</Label>
            <div className="flex gap-2">
              <Input
                id="wa-token"
                type="password"
                autoComplete="off"
                className="h-10 min-w-0"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={whatsappOfficial.accessTokenLast4 ? `Termina em ${whatsappOfficial.accessTokenLast4} · cole um novo para trocar` : "Cole o token"}
              />
              <Button type="submit" disabled={!token || savingToken} className="shrink-0">
                {savingToken ? "Salvando…" : "Trocar"}
              </Button>
            </div>
          </div>
          <CopyField id="wa-webhook" label="URL do webhook" value={whatsappOfficial.webhookUrl} mono />
          <CopyField id="wa-verify" label="Token de verificação" value={whatsappOfficial.verifyToken} mono />
        </form>
        {tokenFeedback ? (
          <Alert tone={tokenFeedback.tone} live>
            {tokenFeedback.text}
          </Alert>
        ) : null}
        <p className="text-[13px] text-ink-2">
          Números da API oficial são adicionados em{" "}
          <Link href="/canais" className="font-semibold underline">
            Canais
          </Link>
          . O token fica cifrado: mostramos só os últimos 4 caracteres.
        </p>
      </Card>
    </>
  );
}
