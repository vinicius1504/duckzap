"use client";

import type { AppointmentType, AgentConfig } from "@duckzap/contracts/agents";
import { Checkbox, Select } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { respondWhenLabel } from "../labels";
import type { TabProps } from "./agent-editor";

/** Regras de atendimento: quando responde, quando chama uma pessoa, jeito de responder e limite de mensagens. */
export function RulesSettings({ config, setConfig }: TabProps) {
  const b = config.behavior;
  const behavior = (patch: Partial<AgentConfig["behavior"]>) => setConfig({ ...config, behavior: { ...b, ...patch } });
  const respondOptions = Object.keys(respondWhenLabel).filter((k): k is AgentConfig["behavior"]["respondWhen"] => k in respondWhenLabel);
  return (
    <div className="flex flex-col gap-6">
      <div className="max-w-md">
        <Label htmlFor="ag-when">Quando o agente responde</Label>
        <Select
          id="ag-when"
          value={b.respondWhen}
          onChange={(e) => {
            const next = respondOptions.find((o) => o === e.target.value);
            if (next) behavior({ respondWhen: next });
          }}
        >
          {respondOptions.map((o) => (
            <option key={o} value={o}>
              {respondWhenLabel[o]}
            </option>
          ))}
        </Select>
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1.5 text-[13px] font-semibold">Chamar uma pessoa quando</legend>
        {(
          [
            ["handoffOnRequest", "O cliente pedir para falar com alguém"],
            ["handoffOnComplaint", "Houver reclamação ou urgência"],
            ["handoffOnUnknown", "A pergunta não estiver no conhecimento do agente"],
          ] as const
        ).map(([key, text]) => (
          <label key={key} className="flex min-h-11 items-center gap-2.5">
            <Checkbox checked={b[key]} onChange={(e) => setConfig({ ...config, behavior: { ...b, [key]: e.target.checked } })} />
            {text}
          </label>
        ))}
        <p className="text-xs text-ink-2">
          Sempre chama uma pessoa também se a IA tiver pouca certeza ou se uma ferramenta falhar duas vezes seguidas.
        </p>
      </fieldset>

      <div>
        <Label htmlFor="ag-creativity">Jeito de responder</Label>
        <div className="flex max-w-md items-center gap-3">
          <span className="shrink-0 text-[13px] text-ink-2">Mais preciso</span>
          <input
            id="ag-creativity"
            type="range"
            min={0}
            max={10}
            value={b.creativity}
            aria-valuetext={`${b.creativity} de 10`}
            onChange={(e) => behavior({ creativity: Number(e.target.value) })}
            className="h-11 min-w-0 flex-1 accent-ink"
          />
          <span className="shrink-0 text-[13px] text-ink-2">Mais criativo</span>
        </div>
      </div>

      <div className="max-w-56">
        <Label htmlFor="ag-max">Limite de mensagens seguidas do agente</Label>
        <Input
          id="ag-max"
          type="number"
          inputMode="numeric"
          min={1}
          max={20}
          value={b.maxConsecutiveMessages}
          onChange={(e) => behavior({ maxConsecutiveMessages: Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
        />
        <p className="mt-1 text-xs text-ink-2">Passou disso sem resposta do cliente, o agente para e espera.</p>
      </div>
    </div>
  );
}
