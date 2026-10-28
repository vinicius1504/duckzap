import { describe, expect, it } from "vitest";
import { createCoalescer } from "./coalesce";
import { FakeClock } from "./fake";

describe("createCoalescer", () => {
  it("junta uma rajada em uma execução no fim da janela", () => {
    const clock = new FakeClock();
    let calls = 0;
    const c = createCoalescer(() => calls++, 400, clock);
    c.trigger();
    clock.advance(100);
    c.trigger();
    clock.advance(100);
    c.trigger();
    expect(calls).toBe(0);
    expect(c.pending).toBe(true);
    clock.advance(200);
    expect(calls).toBe(1);
    expect(c.pending).toBe(false);
    clock.advance(5000);
    expect(calls).toBe(1);
  });

  it("depois de executar, um novo aviso abre outra janela (no máximo um por 400 ms)", () => {
    const clock = new FakeClock();
    const times: number[] = [];
    const c = createCoalescer(() => times.push(clock.now), 400, clock);
    for (let t = 0; t < 1700; t += 50) {
      c.trigger();
      clock.advance(50);
    }
    clock.advance(400);
    expect(times.length).toBeGreaterThan(1);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(400);
  });

  it("cancel descarta o pendente", () => {
    const clock = new FakeClock();
    let calls = 0;
    const c = createCoalescer(() => calls++, 400, clock);
    c.trigger();
    c.cancel();
    clock.advance(1000);
    expect(calls).toBe(0);
    c.trigger();
    clock.advance(400);
    expect(calls).toBe(1);
  });
});
