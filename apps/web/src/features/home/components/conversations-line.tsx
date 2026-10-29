"use client";

import { useEffect, useRef, useState } from "react";
import { formatShortWeekday } from "@/lib/format";

type DayPoint = { date: string; count: number };

const HEIGHT = 220;
const PAD = { left: 32, right: 12, top: 14, bottom: 30 };
/** espaço mínimo entre rótulos do eixo X (com 30 dias eles não cabem todos) */
const MIN_LABEL_GAP = 44;

/**
 * Desenhada em pixels reais (1 unidade = 1px): o texto e as bolinhas mantêm o tamanho em qualquer largura.
 * Medimos o contêiner em vez de esticar um viewBox, que inflava os rótulos em telas largas.
 */
export function ConversationsLine({ data, timeZone }: { data: readonly DayPoint[]; timeZone?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setWidth(Math.max(240, Math.round(node.clientWidth)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const left = PAD.left;
  const right = width - PAD.right;
  const bottom = HEIGHT - PAD.bottom;
  const max = Math.max(45, Math.ceil(Math.max(0, ...data.map((p) => p.count)) / 15) * 15);
  const ticks = [0, max / 3, (max / 3) * 2, max];
  const step = data.length > 1 ? (right - left) / (data.length - 1) : 0;
  const y = (value: number) => bottom - (value / max) * (bottom - PAD.top);
  const points = data.map((point, index) => ({
    ...point,
    day: formatShortWeekday(point.date, timeZone),
    x: data.length > 1 ? left + index * step : (left + right) / 2,
    y: y(point.count),
  }));
  const labelEvery = step > 0 ? Math.max(1, Math.ceil(MIN_LABEL_GAP / step)) : 1;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join("");
  const label = `Linha de conversas por dia: ${points.map((p) => `${p.day} ${p.count}`).join(", ")}`;

  return (
    <div ref={ref} className="mt-2.5 w-full">
      <svg width={width} height={HEIGHT} role="img" aria-label={label} className="block max-w-full">
        <g stroke="var(--line)">
          {ticks.map((tick) => (
            <path key={tick} d={`M${left - 4} ${y(tick)}H${right + 4}`} />
          ))}
        </g>
        <g fill="var(--ink2)" fontSize="11">
          {ticks.map((tick) => (
            <text key={tick} x={left - 10} y={y(tick) + 4} textAnchor="end">
              {Math.round(tick)}
            </text>
          ))}
          {points.map((p, index) =>
            index % labelEvery === 0 ? (
              <text key={p.date} x={p.x} y={HEIGHT - 8} textAnchor="middle">
                {p.day}
              </text>
            ) : null,
          )}
        </g>
        {points.length > 1 ? <path d={`${line}V${bottom}H${left}z`} fill="var(--duck)" opacity=".25" /> : null}
        <path d={line} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />
        <g fill="var(--surface)" stroke="var(--ink)" strokeWidth="2">
          {points.map((p) => (
            <circle key={p.date} cx={p.x} cy={p.y} r="3.5" />
          ))}
        </g>
      </svg>
    </div>
  );
}
