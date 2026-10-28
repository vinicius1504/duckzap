"use client";

import type { RealtimeEvent } from "@duckzap/contracts/realtime";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import type { RealtimeClient, RealtimeNotice, RealtimeStatus } from "./client";

export const RealtimeContext = createContext<RealtimeClient | null>(null);

const noopSubscribe = () => () => {};
const offlineSnapshot = (): RealtimeStatus => "offline";
const connectingSnapshot = (): RealtimeStatus => "connecting";

/** `false` fora do provider (conta bloqueada): os controles de tempo real não aparecem. */
export function useRealtimeAvailable(): boolean {
  return useContext(RealtimeContext) !== null;
}

export function useRealtimeClient(): RealtimeClient | null {
  return useContext(RealtimeContext);
}

/** "connecting" | "online" | "offline". Fora do provider, sempre "offline". */
export function useRealtimeStatus(): RealtimeStatus {
  const client = useContext(RealtimeContext);
  return useSyncExternalStore(client?.onStatus ?? noopSubscribe, client?.getStatus ?? offlineSnapshot, connectingSnapshot);
}

/**
 * Recebe cada aviso (sem repetidos). O `handler` pode mudar a cada render: a inscrição é feita uma vez só
 * e sempre chama a versão mais recente.
 */
export function useRealtimeEvent(handler: (event: RealtimeEvent, notice: RealtimeNotice) => void): void {
  const client = useContext(RealtimeContext);
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!client) return;
    return client.subscribe((notice) => latest.current(notice.event, notice));
  }, [client]);
}

/** Chamado quando a conexão volta depois de uma queda (avisos podem ter sido perdidos). */
export function useRealtimeResync(handler: () => void): void {
  const client = useContext(RealtimeContext);
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!client) return;
    return client.onResync(() => latest.current());
  }, [client]);
}
