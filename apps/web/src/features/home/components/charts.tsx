import { formatShortWeekday } from "@/lib/format";

type DayPoint = { date: string; count: number };

export function ConversationsLine({ data }: { data: readonly DayPoint[] }) {
  const left = 40;
  const right = 550;
  const top = 35;
  const bottom = 170;
  const max = Math.max(45, Math.ceil(Math.max(...data.map((p) => p.count)) / 15) * 15);
  const ticks = [0, max / 3, (max / 3) * 2, max];
  const step = data.length > 1 ? (right - left) / (data.length - 1) : 0;
  const y = (value: number) => bottom - (value / max) * (bottom - top);
  const points = data.map((point, index) => ({ ...point, day: formatShortWeekday(point.date), x: left + index * step, y: y(point.count) }));
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join("");
  const label = `Linha de conversas por dia: ${points.map((p) => `${p.day} ${p.count}`).join(", ")}`;

  return (
    <svg viewBox="0 0 580 210" role="img" aria-label={label} className="mt-2.5 h-auto w-full">
      <g stroke="var(--line)">
        {ticks.map((tick) => (
          <path key={tick} d={`M30 ${y(tick)}H570`} />
        ))}
      </g>
      <g fill="var(--ink2)" fontSize="11">
        {ticks.map((tick) => (
          <text key={tick} x="4" y={y(tick) + 4}>
            {Math.round(tick)}
          </text>
        ))}
        {points.map((p) => (
          <text key={p.date} x={p.x - 12} y="195">
            {p.day}
          </text>
        ))}
      </g>
      <path d={`${line}V${bottom}H${left}z`} fill="var(--duck)" opacity=".25" />
      <path d={line} fill="none" stroke="var(--ink)" strokeWidth="2.5" strokeLinejoin="round" />
      <g fill="var(--surface)" stroke="var(--ink)" strokeWidth="2.5">
        {points.map((p) => (
          <circle key={p.date} cx={p.x} cy={p.y} r="4" />
        ))}
      </g>
    </svg>
  );
}

/** Cores das etapas do funil, na ordem (as 4 primeiras etiquetas são as etapas). */
export const funnelColors = ["var(--ink)", "var(--duck)", "#6F8DA1", "var(--field)"];

type Slice = { stage: string; percent: number };

export function FunnelDonut({ data }: { data: readonly Slice[] }) {
  const circumference = 2 * Math.PI * 52;
  const label = `Rosca: ${data.map((s) => `${s.stage.toLowerCase()} ${s.percent}%`).join(", ")}`;
  const slices = data.map((slice, index) => {
    const before = data.slice(0, index).reduce((sum, s) => sum + (s.percent / 100) * circumference, 0);
    return { ...slice, length: (slice.percent / 100) * circumference, offset: before, color: funnelColors[index % funnelColors.length] };
  });

  return (
    <svg width="132" height="132" viewBox="0 0 132 132" role="img" aria-label={label}>
      <g fill="none" strokeWidth="18" transform="rotate(-90 66 66)">
        {slices.map((slice) => (
          <circle
            key={slice.stage}
            cx="66"
            cy="66"
            r="52"
            stroke={slice.color}
            strokeDasharray={`${slice.length} ${circumference - slice.length}`}
            strokeDashoffset={-slice.offset}
          />
        ))}
      </g>
    </svg>
  );
}
