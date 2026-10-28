"use client";

import { useEffect, useRef, useState } from "react";
import { useRealtimeEvent } from "./hooks";
import { TypingTracker, type TypingState } from "./typing";

const IDLE: TypingState = { contact: false, agent: false };

/** Quem está digitando na conversa `conversationId` (some sozinho ~6 s depois do último sinal). */
export function useTyping(conversationId: string): TypingState {
  const [state, setState] = useState<TypingState>(IDLE);
  const tracker = useRef<TypingTracker | null>(null);

  useEffect(() => {
    const instance = new TypingTracker(setState);
    tracker.current = instance;
    return () => {
      instance.reset();
      tracker.current = null;
    };
  }, [conversationId]);

  useRealtimeEvent((event) => tracker.current?.handle(event, conversationId));

  return state;
}
