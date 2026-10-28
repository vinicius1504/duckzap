import { describe, expect, it } from "vitest";
import { FakeClock } from "./fake";
import { TypingTracker, type TypingState } from "./typing";

function setup() {
  const clock = new FakeClock();
  const states: TypingState[] = [];
  const tracker = new TypingTracker((s) => states.push(s), 6000, clock);
  return { clock, states, tracker };
}

describe("TypingTracker", () => {
  it("mostra quem digita e some sozinho depois de 6 s sem renovar", () => {
    const { clock, tracker } = setup();
    tracker.handle({ type: "typing", conversationId: "c1", actor: "contact", active: true }, "c1");
    expect(tracker.current).toEqual({ contact: true, agent: false });
    clock.advance(5000);
    expect(tracker.current.contact).toBe(true);
    clock.advance(1000);
    expect(tracker.current.contact).toBe(false);
  });

  it("renovar o sinal estende o prazo", () => {
    const { clock, tracker } = setup();
    const ev = { type: "typing", conversationId: "c1", actor: "agent", active: true } as const;
    tracker.handle(ev, "c1");
    clock.advance(4000);
    tracker.handle(ev, "c1");
    clock.advance(4000);
    expect(tracker.current.agent).toBe(true);
    clock.advance(2000);
    expect(tracker.current.agent).toBe(false);
  });

  it("active:false limpa na hora e ignora outras conversas", () => {
    const { tracker, states } = setup();
    tracker.handle({ type: "typing", conversationId: "outra", actor: "contact", active: true }, "c1");
    expect(states).toHaveLength(0);
    tracker.handle({ type: "typing", conversationId: "c1", actor: "contact", active: true }, "c1");
    tracker.handle({ type: "typing", conversationId: "c1", actor: "contact", active: false }, "c1");
    expect(tracker.current.contact).toBe(false);
  });

  it("mensagem do contato encerra o 'digitando' dele; a do agente, o do agente", () => {
    const { tracker } = setup();
    tracker.handle({ type: "typing", conversationId: "c1", actor: "contact", active: true }, "c1");
    tracker.handle({ type: "typing", conversationId: "c1", actor: "agent", active: true }, "c1");
    tracker.handle({ type: "conversation.message", conversationId: "c1", direction: "in" }, "c1");
    expect(tracker.current).toEqual({ contact: false, agent: true });
    tracker.handle({ type: "conversation.message", conversationId: "c1", direction: "out" }, "c1");
    expect(tracker.current).toEqual({ contact: false, agent: false });
  });

  it("reset limpa tudo e cancela os timers", () => {
    const { clock, tracker } = setup();
    tracker.handle({ type: "typing", conversationId: "c1", actor: "contact", active: true }, "c1");
    tracker.reset();
    expect(tracker.current.contact).toBe(false);
    expect(clock.pending).toBe(0);
  });
});
