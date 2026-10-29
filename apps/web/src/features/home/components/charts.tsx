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
