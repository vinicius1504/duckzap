import { brand } from "@duckzap/brand";
import type { OnboardingDraft } from "@duckzap/contracts/onboarding";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip, type ChipTone } from "@duckzap/ui/components/chip";
import { Icon } from "@duckzap/ui/components/icon";
import Link from "next/link";
import { formatPhone } from "@/lib/format";
import { StartOverButton } from "./start-over-button";

/** Linha do agente: o que foi criado de verdade e o que ainda falta para ele responder clientes. */
function agentRow(draft: OnboardingDraft): { value: string; tone: ChipTone; status: string; hints: string[] } {
  const setup = draft.agentSetup;
  if (!setup) return { value: "Nenhum agente", tone: "warn", status: "A criar", hints: ["Crie em Agentes de IA."] };
  const hints = ["O que você vende já está no conhecimento dele."];
  if (setup.active) {
    hints.unshift("Já responde seus clientes no WhatsApp.");
  } else if (setup.activationError) {
    hints.unshift(`Não conseguimos ativar o agente: ${setup.activationError}`);
  } else if (setup.channelLinked) {
    hints.unshift("Conecte o seu WhatsApp em Canais para ativar o seu agente.");
  } else {
    hints.unshift("Conecte um canal em Canais para ativar o seu agente.");
  }
  if (setup.needsAppointmentTypes) hints.push("Cadastre os tipos de atendimento em Agenda para ele conseguir marcar horários.");
  return { value: setup.name, tone: setup.active ? "ok" : "warn", status: setup.active ? "Ativo" : "Criado, inativo", hints };
}

/** "Tudo pronto": resumo do que foi configurado e o caminho para entrar. */
export function DoneStep({ draft }: { draft: OnboardingDraft }) {
  const agent = agentRow(draft);
  const rows: { label: string; value: string; tone: ChipTone; status: string; hints?: string[] }[] = [
    {
      label: "Empresa",
      value: draft.company?.companyName ?? "Dados da empresa",
      tone: draft.company ? "ok" : "warn",
      status: draft.company ? "Configurada" : "A configurar",
      hints: draft.company ? undefined : ["Complete em Ajustes › Empresa."],
    },
    {
      label: "WhatsApp",
      value: draft.whatsapp?.phone ? formatPhone(draft.whatsapp.phone) : "Nenhum número",
      tone: draft.whatsapp?.status === "connected" ? "ok" : "warn",
      status: draft.whatsapp?.status === "connected" ? "Conectado" : "A conectar",
      hints: draft.whatsapp?.status === "connected" ? undefined : ["Conecte em Canais quando quiser."],
    },
    { label: "Primeiro agente", value: agent.value, tone: agent.tone, status: agent.status, hints: agent.hints },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col items-center gap-6 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-ok-bg text-ok">
        <Icon name="check" size={34} strokeWidth={2.4} />
      </span>
      <div>
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">
          Tudo pronto, {draft.account.name.split(" ")[0]}!
        </h1>
        <p className="mt-1.5 text-ink-2">
          Sua conta foi criada com o e-mail{" "}
          <strong className="break-all text-ink">{draft.account.email}</strong>. Entre para começar
          a atender.
        </p>
      </div>
      <Card className="w-full text-left">
        <ul>
          {rows.map((row) => (
            <li
              key={row.label}
              className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4 last:border-b-0"
            >
              <div className="min-w-0 flex-[1_1_200px]">
                <p className="text-[13px] text-ink-2">{row.label}</p>
                <p className="font-semibold">{row.value}</p>
                {row.hints?.map((hint) => (
                  <p key={hint} className="text-[13px] text-ink-2">
                    {hint}
                  </p>
                ))}
              </div>
              <Chip tone={row.tone}>{row.status}</Chip>
            </li>
          ))}
        </ul>
      </Card>
      <Link
        href="/entrar"
        className={buttonVariants({ variant: "primary", size: "lg", className: "w-full max-w-xs" })}
      >
        Entrar no {brand.name}
        <Icon name="arrowRight" size={18} />
      </Link>
      <StartOverButton />
    </div>
  );
}
