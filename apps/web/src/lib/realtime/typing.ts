import type { RealtimeEvent } from "@duckzap/contracts/realtime";
import { browserTimers, type TimerApi } from "./coalesce";

export type TypingActor = "contact" | "agent";
export type TypingState = { contact: boolean; agent: boolean };

/**
 * Quem está digitando na conversa aberta. O sinal é efêmero: se não for renovado em `ttlMs`, some
 * (o servidor pode perder o "parou de digitar"). Uma mensagem do mesmo lado também encerra o aviso.
 */
export class TypingTracker {
  private state: TypingState = { contact: false, agent: false };
  private readonly pending: Partial<Record<TypingActor, unknown>> = {};

  constructor(
    private readonly onChange: (state: TypingState) => void,
    private readonly ttlMs = 6000,
    private readonly timers: TimerApi = browserTimers,
  ) {}

  get current(): TypingState {
    return this.state;
  }

  handle(event: RealtimeEvent, conversationId: string): void {
    if (event.type === "typing" && event.conversationId === conversationId) {
      this.set(event.actor, event.active);
    } else if (event.type === "conversation.message" && event.conversationId === conversationId) {
      if (event.direction === "in") this.set("contact", false);
      else if (event.direction === "out") this.set("agent", false);
    }
  }

  reset(): void {
    this.set("contact", false);
    this.set("agent", false);
  }

  private set(actor: TypingActor, active: boolean): void {
    const handle = this.pending[actor];
    if (handle !== undefined) this.timers.clearTimeout(handle);
    delete this.pending[actor];
    if (active) {
      this.pending[actor] = this.timers.setTimeout(() => {
        delete this.pending[actor];
        this.update(actor, false);
      }, this.ttlMs);
    }
    this.update(actor, active);
  }

  private update(actor: TypingActor, active: boolean): void {
    if (this.state[actor] === active) return;
    this.state = { ...this.state, [actor]: active };
    this.onChange(this.state);
  }
}
