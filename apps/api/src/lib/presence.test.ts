import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TYPING_MS } from "./messaging";
import { clearPresenceHandlers, dispatchPresence, registerPresenceHandler, typingMsForText, TYPING_MS_MAX, TYPING_MS_MIN, TYPING_MS_PER_CHAR } from "./presence";

afterEach(() => clearPresenceHandlers());

describe("typingMsForText: digitando… proporcional ao texto", () => {
  it("~35 ms por caractere, entre 800 ms e 6 s", () => {
    expect(TYPING_MS_PER_CHAR).toBe(35);
    expect(typingMsForText("x".repeat(40))).toBe(1400);
    expect(typingMsForText("x".repeat(100))).toBe(3500);
  });

  it("texto curto fica no piso; texto longo, no teto; nunca passa do teto compartilhado", () => {
    expect(typingMsForText("oi")).toBe(TYPING_MS_MIN);
    expect(typingMsForText("x".repeat(10))).toBe(TYPING_MS_MIN);
    expect(typingMsForText("x".repeat(172))).toBe(TYPING_MS_MAX);
    expect(typingMsForText("x".repeat(100_000))).toBe(TYPING_MS_MAX);
    expect(TYPING_MS_MAX).toBeLessThanOrEqual(MAX_TYPING_MS);
  });

  it("vazio ou só espaços = 0 (nada a mostrar); espaços nas pontas não contam", () => {
    expect(typingMsForText("")).toBe(0);
    expect(typingMsForText("   \n ")).toBe(0);
    expect(typingMsForText(`  ${"x".repeat(40)}  `)).toBe(1400);
  });

  it("é monótono: texto maior nunca digita menos", () => {
    let last = 0;
    for (let n = 1; n < 400; n += 7) {
      const ms = typingMsForText("x".repeat(n));
      expect(ms).toBeGreaterThanOrEqual(last);
      last = ms;
    }
  });
});

describe("dispatchPresence", () => {
  const context = { organizationId: "org_a", channelId: "c1", from: "+5567999990000", presence: "composing" as const };

  it("chama todos os handlers em ordem", async () => {
    const calls: string[] = [];
    registerPresenceHandler(async () => void calls.push("a"));
    registerPresenceHandler(async () => void calls.push("b"));
    await dispatchPresence(context);
    expect(calls).toEqual(["a", "b"]);
  });

  it("handler que lança não derruba nem impede os outros (presença é melhor esforço)", async () => {
    const after = vi.fn(async () => {});
    registerPresenceHandler(async () => Promise.reject(new Error("banco caiu")));
    registerPresenceHandler(after);
    await expect(dispatchPresence(context)).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("sem handler registrado não faz nada", async () => {
    await expect(dispatchPresence(context)).resolves.toBeUndefined();
  });
});
