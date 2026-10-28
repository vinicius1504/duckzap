"use client";

import type { Channel, ChannelType } from "@duckzap/contracts/channels";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { Icon, type IconName } from "@duckzap/ui/components/icon";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { Steps } from "@duckzap/ui/components/layout";
import { cn } from "@duckzap/ui/cn";
import Link from "next/link";
import { useState, useTransition } from "react";
import { createChannelAction } from "../actions";
import { ConnectStep, QrRiskWarning } from "./connect-step";

const typeOptions: { value: ChannelType; title: string; description: string; icon: IconName }[] = [
  {
    value: "whatsapp_qr",
    title: "WhatsApp por QR Code",
    description: "Grátis e conecta em 1 minuto com o celular. Não oficial: há risco de bloqueio.",
    icon: "qr",
  },
  {
    value: "whatsapp_official",
    title: "WhatsApp API oficial",
    description: "Da Meta. Mais estável e ideal para campanhas. A Meta cobra por conversa.",
    icon: "shield",
  },
  {
    value: "instagram",
    title: "Instagram",
    description: "DMs e comentários da sua conta profissional.",
    icon: "instagram",
  },
];

const steps = ["Tipo", "Nome", "Conectar"] as const;

export function NewChannelWizard({
  allowedTypes,
  limitReached,
  limitMax,
}: {
  allowedTypes: ChannelType[];
  limitReached: boolean;
  limitMax: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [type, setType] = useState<ChannelType>("whatsapp_qr");
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [connected, setConnected] = useState(false);
  const [pending, startTransition] = useTransition();

  function reset() {
    setStep(0);
    setType("whatsapp_qr");
    setRiskAccepted(false);
    setName("");
    setError(null);
    setChannel(null);
    setConnected(false);
  }

  function create() {
    startTransition(async () => {
      const result = await createChannelAction({ type, name });
      if (result.ok) {
        setError(null);
        setChannel(result.data);
        setStep(2);
      } else setError(result.error);
    });
  }

  if (limitReached)
    return (
      <div className="flex flex-col items-end gap-1">
        <Button variant="primary" disabled aria-describedby="novo-canal-limite">
          Novo canal
        </Button>
        <p id="novo-canal-limite" className="text-[13px] text-ink-2">
          Limite de {limitMax} canais do plano atingido.
        </p>
      </div>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="primary">
          <Icon name="plus" size={18} strokeWidth={2.2} />
          Novo canal
        </Button>
      </DialogTrigger>
      <DialogContent title="Novo canal" size="md">
        <Steps steps={steps} current={connected ? 3 : step} label="Etapas do novo canal" />

        {step === 0 ? (
          <>
            <fieldset className="flex flex-col gap-2.5">
              <legend className="mb-2 font-semibold">Por onde seus clientes vão falar com você?</legend>
              {typeOptions.map((option) => {
                const allowed = allowedTypes.includes(option.value);
                return (
                  <label
                    key={option.value}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-control border border-line p-3.5 has-[:checked]:border-duck has-[:checked]:bg-surface-2",
                      !allowed && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="radio"
                      name="tipo-canal"
                      value={option.value}
                      checked={type === option.value}
                      disabled={!allowed}
                      onChange={() => {
                        setType(option.value);
                        setRiskAccepted(false);
                      }}
                      className="mt-1 size-[18px] shrink-0 accent-ink"
                    />
                    <Icon name={option.icon} size={22} className="mt-0.5 shrink-0" />
                    <span className="flex-1">
                      <span className="flex flex-wrap items-center gap-2 font-bold">
                        {option.title}
                        {!allowed ? <Chip>Plano Pro</Chip> : null}
                      </span>
                      <span className="block text-[13px] text-ink-2">
                        {allowed ? option.description : "Disponível nos planos Pro e Empresarial. Veja em Ajustes › Plano e cobrança."}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {type === "whatsapp_qr" ? (
              <>
                <QrRiskWarning />
                <label className="flex items-start gap-2.5">
                  <Checkbox checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)} className="mt-0.5" />
                  Entendi os riscos da conexão não oficial.
                </label>
              </>
            ) : null}
            <DialogFooter>
              <Button variant="primary" disabled={type === "whatsapp_qr" && !riskAccepted} onClick={() => setStep(1)}>
                Continuar
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {step === 1 ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
            className="flex flex-col gap-4"
            noValidate
          >
            <div>
              <Label htmlFor="novo-canal-nome">Nome do canal</Label>
              <Input
                id="novo-canal-nome"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={type === "instagram" ? "Ex.: @suaempresa" : "Ex.: Recepção 3"}
                maxLength={40}
                autoFocus
                invalid={Boolean(error)}
                aria-describedby={error ? "novo-canal-erro" : "novo-canal-dica"}
              />
              <p id="novo-canal-dica" className="mt-1.5 text-[13px] text-ink-2">
                Só a sua equipe vê este nome.
              </p>
              <FieldError id="novo-canal-erro" message={error ?? undefined} />
            </div>
            <DialogFooter className="justify-between">
              <Button onClick={() => setStep(0)}>Voltar</Button>
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Criando…" : "Criar e conectar"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {step === 2 && channel ? (
          connected ? (
            <div className="flex flex-col gap-4">
              <Alert tone="ok" live title="Pronto!">
                {channel.name} está conectado. Agora escolha a equipe, o agente e as mensagens do canal.
              </Alert>
              <DialogFooter>
                <Button onClick={() => setOpen(false)}>Concluir</Button>
                <Link
                  href={`/canais?canal=${channel.id}#mensagens`}
                  onClick={() => setOpen(false)}
                  className={buttonVariants({ variant: "primary" })}
                >
                  Configurar o canal
                </Link>
              </DialogFooter>
            </div>
          ) : (
            <>
              <ConnectStep channel={channel} onConnected={() => setConnected(true)} />
              <DialogFooter className="justify-between">
                <p className="self-center text-[13px] text-ink-2">Pode fechar e conectar depois pela lista.</p>
                <Button onClick={() => setOpen(false)}>Fechar</Button>
              </DialogFooter>
            </>
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
