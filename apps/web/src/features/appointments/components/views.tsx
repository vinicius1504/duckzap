"use client";

import type { Appointment } from "@duckzap/contracts/appointments";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import { cn } from "@duckzap/ui/cn";
import { statusView } from "../labels";
import { daysBetween, formatDay, shortTime, zonedDay, zonedMinutes, zonedTime } from "../time";

export type ViewProps = {
  appointments: Appointment[];
  from: string;
  to: string;
  today: string;
  nowIso: string;
  timeZone: string;
  conflictIds: Set<string>;
  typeName: (id: string) => string;
  ownerName: (id: string) => string;
  onOpen: (id: string) => void;
};

const HOUR_START = 7;
const HOUR_END = 20;
/**
 * A grade da semana ocupa a altura que sobra na tela (sem rolagem da página): 13 horas, de 28 px (mínimo) a 56 px por hora.
 * O 266 é o que há em volta dela (barra do topo, margens, barra da agenda e cabeçalho dos dias). As posições dos
 * agendamentos são em percentual da grade, então acompanham qualquer altura.
 */
const WEEK_GRID_MIN_HEIGHT = `clamp(${(HOUR_END - HOUR_START) * 28}px, calc(100dvh - 266px), ${(HOUR_END - HOUR_START) * 56}px)`;
const DAY_MINUTES = (HOUR_END - HOUR_START) * 60;

function firstName(name: string) {
  const parts = name.split(" ");
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]?.[0] ?? ""}.` : name;
}

function groupByDay(appointments: Appointment[], timeZone: string) {
  const map = new Map<string, Appointment[]>();
  for (const a of appointments) {
    const day = zonedDay(a.startsAt, timeZone);
    const list = map.get(day) ?? [];
    list.push(a);
    map.set(day, list);
  }
  return map;
}

/** Colunas lado a lado para agendamentos que se sobrepõem no mesmo dia. */
function layoutDay(items: Appointment[]) {
  const sorted = [...items].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const result = new Map<string, { lane: number; lanes: number }>();
  let cluster: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = 0;
  const flush = () => {
    const lanes = laneEnds.length || 1;
    for (const c of cluster) result.set(c.id, { lane: c.lane, lanes });
    cluster = [];
    laneEnds = [];
  };
  for (const a of sorted) {
    const start = Date.parse(a.startsAt);
    const end = Date.parse(a.endsAt);
    if (cluster.length && start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((e) => e <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else laneEnds[lane] = end;
    cluster.push({ id: a.id, lane });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return result;
}

function eventLabel(a: Appointment, props: ViewProps) {
  const conflict = props.conflictIds.has(a.id) ? ", conflito de horário" : "";
  return `${zonedTime(a.startsAt, props.timeZone)} ${props.typeName(a.typeId)} com ${a.contactName}, ${props.ownerName(a.ownerId)}, ${statusView[a.status].label}${conflict}`;
}

export function WeekView(props: ViewProps) {
  const days = daysBetween(props.from, props.to);
  const byDay = groupByDay(props.appointments, props.timeZone);
  const hours = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);
  const nowPercent = ((zonedMinutes(props.nowIso, props.timeZone) - HOUR_START * 60) / DAY_MINUTES) * 100;

  return (
    <Card className="flex flex-1 flex-col overflow-x-auto overflow-y-hidden">
      <div className="flex min-w-[760px] flex-1 flex-col">
        <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-line bg-bg">
          <span />
          {days.map((day) => {
            const isToday = day === props.today;
            return (
              <div key={day} className="p-2.5 text-center">
                <span className="text-xs text-ink-2">{formatDay(day, { weekday: "short" }).replace(".", "")}</span>
                <br />
                <strong
                  className={cn("inline-flex size-[30px] items-center justify-center rounded-full text-base", isToday && "bg-duck text-on-duck")}
                  aria-current={isToday ? "date" : undefined}
                >
                  {Number(day.slice(8))}
                </strong>
              </div>
            );
          })}
        </div>
        <div className="grid flex-1 grid-cols-[56px_repeat(7,minmax(0,1fr))]" style={{ minHeight: WEEK_GRID_MIN_HEIGHT }}>
          <div className="flex flex-col pr-2 text-right text-[11px] text-ink-2" aria-hidden="true">
            {hours.map((h) => (
              <span key={h} className="flex-1">
                {String(h).padStart(2, "0")}h
              </span>
            ))}
          </div>
          {days.map((day) => {
            const items = byDay.get(day) ?? [];
            const layout = layoutDay(items);
            const weekend = [5, 6].includes(days.indexOf(day));
            return (
              <div
                key={day}
                role="list"
                aria-label={formatDay(day, { weekday: "long", day: "numeric", month: "long" })}
                className={cn("relative border-l border-line", weekend && "bg-bg")}
                style={{
                  backgroundImage: "linear-gradient(to bottom, transparent calc(100% - 1px), var(--line) calc(100% - 1px))",
                  backgroundSize: `100% calc(100% / ${hours.length})`,
                }}
              >
                {items.map((a) => {
                  const start = Math.max(zonedMinutes(a.startsAt, props.timeZone), HOUR_START * 60);
                  const minutes = (Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60000;
                  const topPercent = ((start - HOUR_START * 60) / DAY_MINUTES) * 100;
                  const heightPercent = Math.min((minutes / DAY_MINUTES) * 100, 100 - topPercent);
                  const pos = layout.get(a.id) ?? { lane: 0, lanes: 1 };
                  const conflict = props.conflictIds.has(a.id);
                  return (
                    <div key={a.id} role="listitem">
                      <button
                        type="button"
                        onClick={() => props.onOpen(a.id)}
                        aria-label={eventLabel(a, props)}
                        className={cn(
                          "absolute overflow-hidden rounded-lg px-2 py-1 text-left text-xs leading-tight",
                          statusView[a.status].block,
                          conflict && "ring-2 ring-err",
                        )}
                        style={{
                          top: `${topPercent}%`,
                          height: `calc(${heightPercent}% - 2px)`,
                          minHeight: 26,
                          left: `calc(${(pos.lane / pos.lanes) * 100}% + 3px)`,
                          width: `calc(${100 / pos.lanes}% - 6px)`,
                        }}
                      >
                        <strong className="block truncate">
                          {zonedTime(a.startsAt, props.timeZone)} {props.typeName(a.typeId)}
                        </strong>
                        <span className="block truncate">
                          {firstName(a.contactName)} · {conflict ? "Conflito" : statusView[a.status].label}
                        </span>
                      </button>
                    </div>
                  );
                })}
                {day === props.today && nowPercent >= 0 && nowPercent <= 100 ? (
                  <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 h-0.5 bg-err" style={{ top: `${nowPercent}%` }} />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

export function MonthView(props: ViewProps & { month: string; onPickDay: (day: string) => void }) {
  const days = daysBetween(props.from, props.to);
  const byDay = groupByDay(props.appointments, props.timeZone);
  const weekdays = days.slice(0, 7).map((d) => formatDay(d, { weekday: "short" }).replace(".", ""));
  const MAX = 3;

  return (
    <Card className="overflow-x-auto">
      <div className="min-w-[700px]">
        <div className="grid grid-cols-7 border-b border-line bg-bg" aria-hidden="true">
          {weekdays.map((w) => (
            <span key={w} className="p-2.5 text-xs font-bold capitalize text-ink-2">
              {w}
            </span>
          ))}
        </div>
        <ol className="grid grid-cols-7">
          {days.map((day) => {
            const out = day.slice(0, 7) !== props.month;
            const isToday = day === props.today;
            const items = byDay.get(day) ?? [];
            return (
              <li key={day} className={cn("flex min-h-26 flex-col gap-1 border-b border-r border-line p-2", out && "bg-bg")}>
                <button
                  type="button"
                  onClick={() => props.onPickDay(day)}
                  aria-label={`Ver semana de ${formatDay(day, { day: "numeric", month: "long" })}, ${items.length} agendamentos`}
                  aria-current={isToday ? "date" : undefined}
                  className={cn(
                    "flex size-[26px] items-center justify-center rounded-full text-[13px] font-bold hover:bg-surface-hover",
                    out && "text-ink-2",
                    isToday && "bg-duck text-on-duck hover:bg-duck-2",
                  )}
                >
                  {Number(day.slice(8))}
                </button>
                {items.slice(0, MAX).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => props.onOpen(a.id)}
                    aria-label={eventLabel(a, props)}
                    className={cn(
                      "truncate rounded-md px-1.5 py-0.5 text-left text-[11px] font-semibold",
                      statusView[a.status].block,
                      props.conflictIds.has(a.id) && "ring-2 ring-err",
                    )}
                  >
                    {shortTime(a.startsAt, props.timeZone)} {a.contactName.split(" ")[0]}
                  </button>
                ))}
                {items.length > MAX ? (
                  <button type="button" onClick={() => props.onPickDay(day)} className="text-left text-[11px] font-semibold text-ink-2 hover:underline">
                    +{items.length - MAX} mais
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </Card>
  );
}

export function ListView(props: ViewProps & { canManage: boolean; onConfirm: (id: string) => void }) {
  if (props.appointments.length === 0) {
    return (
      <Card>
        <EmptyState icon="calendar" title="Nenhum agendamento neste período" description="Mude o período ou os filtros, ou crie um agendamento." />
      </Card>
    );
  }
  const sorted = [...props.appointments].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return (
    <Table minWidth={680} aria-label="Agendamentos">
      <thead>
        <tr>
          <Th>Quando</Th>
          <Th>Cliente</Th>
          <Th>Tipo</Th>
          <Th>Responsável</Th>
          <Th>Status</Th>
          <Th>
            <span className="sr-only">Ações</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((a) => {
          const day = zonedDay(a.startsAt, props.timeZone);
          const minutes = Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60000);
          const view = statusView[a.status];
          return (
            <tr key={a.id} className={cn(a.status === "canceled" && "text-ink-2")}>
              <Td>
                <strong className="capitalize">
                  {formatDay(day, { weekday: "short", day: "2-digit" }).replace(".", "")} · {zonedTime(a.startsAt, props.timeZone)}
                </strong>
                {props.conflictIds.has(a.id) ? (
                  <Chip tone="err" className="ml-2">
                    Conflito
                  </Chip>
                ) : null}
              </Td>
              <Td>{a.contactName}</Td>
              <Td>
                {props.typeName(a.typeId)} · {minutes} min
              </Td>
              <Td>{props.ownerName(a.ownerId)}</Td>
              <Td>
                <Chip tone={view.tone} className={cn(a.status === "canceled" && "line-through")}>
                  {view.label}
                </Chip>
              </Td>
              <Td className="text-right">
                <span className="inline-flex gap-1.5">
                  {a.status === "pending" && props.canManage ? (
                    <Button size="sm" variant="primary" onClick={() => props.onConfirm(a.id)} className="max-md:h-11">
                      Confirmar
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => props.onOpen(a.id)} className="max-md:h-11">
                    Detalhes
                  </Button>
                </span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
