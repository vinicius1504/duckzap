// Conversão entre o valor de <input type="datetime-local"> (hora da organização) e ISO em UTC.

function parts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { y: map.year ?? "", mo: map.month ?? "", d: map.day ?? "", h: map.hour ?? "", mi: map.minute ?? "" };
}

/** ISO UTC → "2026-11-03T09:00" no fuso dado. */
export function toLocalInput(iso: string, timeZone: string) {
  const p = parts(new Date(iso), timeZone);
  return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}`;
}

/** "2026-11-03T09:00" no fuso dado → ISO UTC. */
export function fromLocalInput(local: string, timeZone: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (y === undefined || mo === undefined || d === undefined || h === undefined || mi === undefined) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = parts(new Date(guess), timeZone);
  const asZoned = Date.UTC(Number(p.y), Number(p.mo) - 1, Number(p.d), Number(p.h), Number(p.mi));
  const offset = asZoned - guess;
  return new Date(guess - offset).toISOString().replace(/\.\d{3}Z$/, "Z");
}
