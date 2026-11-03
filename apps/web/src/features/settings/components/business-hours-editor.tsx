"use client";

import type { BusinessHours, DayHours } from "@duckzap/contracts/settings";
import { FieldError, Input } from "@duckzap/ui/components/input";
import { Switch } from "@duckzap/ui/components/switch";
import { dayLong, dayShort, weekOrder } from "./business-hours";

/** Editor de horário semanal (empresa e equipes). Controlado: `value` + `onChange`. */
export function BusinessHoursEditor({
  idPrefix,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string;
  value: BusinessHours;
  onChange: (next: BusinessHours) => void;
  disabled?: boolean;
}) {
  function patch(day: DayHours["day"], change: Partial<DayHours>) {
    onChange(value.map((h) => (h.day === day ? { ...h, ...change } : h)));
  }

  return (
    <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
      {weekOrder.map((day) => {
        const hours = value.find((h) => h.day === day);
        if (!hours) return null;
        const invalid = hours.open && hours.start >= hours.end;
        const id = `${idPrefix}-${day}`;
        return (
          <li key={day} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
            <span className="w-10 font-semibold">{dayShort[day]}</span>
            <Switch
              checked={hours.open}
              onCheckedChange={(open) => patch(day, { open })}
              aria-label={`Aberto na ${dayLong[day]}`}
              disabled={disabled}
            />
            {hours.open ? (
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={`${id}-inicio`} className="sr-only">
                  Abre às ({dayLong[day]})
                </label>
                <Input
                  id={`${id}-inicio`}
                  type="time"
                  value={hours.start}
                  disabled={disabled}
                  onChange={(e) => patch(day, { start: e.target.value })}
                  className="w-auto"
                />
                <span className="text-ink-2">às</span>
                <label htmlFor={`${id}-fim`} className="sr-only">
                  Fecha às ({dayLong[day]})
                </label>
                <Input
                  id={`${id}-fim`}
                  type="time"
                  value={hours.end}
                  disabled={disabled}
                  invalid={invalid}
                  aria-describedby={invalid ? `${id}-erro` : undefined}
                  onChange={(e) => patch(day, { end: e.target.value })}
                  className="w-auto"
                />
                {invalid ? <FieldError id={`${id}-erro`} message="O fim precisa ser depois do início." /> : null}
              </div>
            ) : (
              <span className="text-ink-2">Fechado</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
