import { formatDay, formatMoney, formatMonthShort } from "@/lib/format";

type MrrPoint = { month: string; mrrCents: number; payingCompanies: number };

/** Linha única de MRR (mesmo estilo do gráfico do Início no app das empresas). */
export function MrrLine({ data }: { data: readonly MrrPoint[] }) {
  const left = 64;
  const right = 560;
  const top = 24;
  const bottom = 170;
  const maxValue = Math.max(1, ...data.map((p) => p.mrrCents));
  const step = 10_000_00;
  const max = Math.ceil(maxValue / step) * step;
  const ticks = [0, max / 2, max];
  const xStep = data.length > 1 ? (right - left) / (data.length - 1) : 0;
  const y = (value: number) => bottom - (value / max) * (bottom - top);
  const points = data.map((p, i) => ({
    ...p,
    label: formatMonthShort(p.month),
    x: left + i * xStep,
    y: y(p.mrrCents),
  }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join("");
  const label = `MRR por mês: ${points.map((p) => `${p.label} ${formatMoney(p.mrrCents)}`).join(", ")}`;

  return (
    <svg viewBox="0 0 580 205" role="img" aria-label={label} className="mt-2.5 h-auto w-full">
      <g stroke="var(--line)">
        {ticks.map((tick) => (
          <path key={tick} d={`M${left - 6} ${y(tick)}H570`} />
        ))}
      </g>
      <g fill="var(--ink2)" fontSize="11">
        {ticks.map((tick) => (
          <text key={tick} x="0" y={y(tick) + 4}>
            {tick === 0 ? "0" : `${Math.round(tick / 100_000)} mil`}
          </text>
        ))}
        {points.map((p) => (
          <text key={p.month} x={p.x} y="195" textAnchor="middle">
            {p.label}
          </text>
        ))}
      </g>
      <path d={`${line}V${bottom}H${left}z`} fill="var(--duck)" opacity=".25" />
      <path d={line} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />
      {points.map((p) => (
        <g key={p.month}>
          <circle
            cx={p.x}
            cy={p.y}
            r="4.5"
            fill="var(--surface)"
            stroke="var(--ink)"
            strokeWidth="2"
          />
          {/* alvo de hover maior que o ponto; o title vira dica nativa */}
          <circle cx={p.x} cy={p.y} r="14" fill="transparent">
            <title>{`${p.label}: ${formatMoney(p.mrrCents)} · ${p.payingCompanies} empresas pagantes`}</title>
          </circle>
        </g>
      ))}
    </svg>
  );
}

/** Barras de novas contas por semana. */
export function SignupBars({ data }: { data: readonly { weekStart: string; count: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <ul className="mt-3.5 flex h-[150px] items-end gap-2" aria-label="Novas contas por semana">
      {data.map((week, i) => {
        const last = i === data.length - 1;
        const label = formatDay(week.weekStart).slice(0, 5);
        return (
          <li
            key={week.weekStart}
            className="flex min-w-0 flex-1 flex-col items-center gap-1 text-xs"
            title={`Semana de ${formatDay(week.weekStart)}: ${week.count}`}
          >
            <span className="sr-only">Semana de {formatDay(week.weekStart)}:</span>
            <span className={last ? "font-bold" : "text-ink-2"}>{week.count}</span>
            <span
              aria-hidden="true"
              className={last ? "w-full rounded-t bg-duck" : "w-full rounded-t bg-ink"}
              style={{ height: `${Math.max(2, (week.count / max) * 96)}px` }}
            />
            <span aria-hidden="true" className="truncate text-ink-2">
              {label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
