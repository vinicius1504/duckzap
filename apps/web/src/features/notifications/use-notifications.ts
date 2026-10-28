"use client";

import type { NotificationList } from "@duckzap/contracts/notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createCoalescer } from "@/lib/realtime/coalesce";
import { useRealtimeAvailable, useRealtimeEvent, useRealtimeResync, useRealtimeStatus } from "@/lib/realtime/hooks";
import { markRead, reconcile, type ReadTarget } from "@/lib/notifications";
import { listNotificationsAction, markNotificationsReadAction } from "./actions";

/** Juntam rajadas de avisos numa busca só. */
const REFETCH_WINDOW_MS = 400;
/** Sem tempo real, o sino confere de tempos em tempos (só com a aba visível). Leve de propósito. */
const POLL_MS = 60_000;

type Phase = "idle" | "loading" | "error";

/**
 * Estado do sino. O contador do servidor (`initialUnread`) vale até a lista ser buscada; depois a lista manda.
 * A lista é buscada ao abrir o sino e a cada aviso `notifications.invalidate` (só ela, nunca `router.refresh()`).
 */
export function useNotifications(initialUnread: number) {
  const [list, setList] = useState<NotificationList | null>(null);
  const [baseUnread, setBaseUnread] = useState(initialUnread);
  const [phase, setPhase] = useState<Phase>("idle");
  // referência de "agora" para os "há 5 min": atualizada a cada busca e ao abrir
  const [now, setNow] = useState(() => Date.now());

  // leituras ainda sendo gravadas: aplicadas por cima de qualquer lista que chegue enquanto isso
  const pending = useRef({ all: false, ids: new Set<string>(), inflight: 0 });
  // cada busca nova invalida as anteriores (resposta antiga não sobrescreve a mais nova)
  const ticket = useRef(0);

  // o layout re-renderizou com outro contador (ex.: o refresh do polling das telas): adota e confere a lista
  const [seenProp, setSeenProp] = useState(initialUnread);
  if (seenProp !== initialUnread) {
    setSeenProp(initialUnread);
    setBaseUnread(initialUnread);
  }

  const load = useCallback(async (spinner: boolean) => {
    const mine = ++ticket.current;
    if (spinner) setPhase("loading");
    let result: Awaited<ReturnType<typeof listNotificationsAction>>;
    try {
      result = await listNotificationsAction();
    } catch {
      result = { ok: false, message: "Não conseguimos carregar as notificações." };
    }
    if (mine !== ticket.current) return;
    if (result.ok) {
      const p = pending.current;
      setList(reconcile(result.data, { all: p.all, ids: p.ids }));
      setNow(Date.now());
      setPhase("idle");
    } else {
      // com uma lista já na tela, falha silenciosa: continua mostrando o que tem
      setPhase("error");
    }
  }, []);

  const coalescer = useRef<ReturnType<typeof createCoalescer> | null>(null);
  useEffect(() => {
    const instance = createCoalescer(() => void load(false), REFETCH_WINDOW_MS);
    coalescer.current = instance;
    return () => {
      instance.cancel();
      coalescer.current = null;
    };
  }, [load]);

  useRealtimeEvent((event) => {
    if (event.type === "notifications.invalidate") coalescer.current?.trigger();
  });
  // conexão voltou depois de uma queda: avisos podem ter se perdido
  useRealtimeResync(() => coalescer.current?.trigger());

  const prevInitial = useRef(initialUnread);
  useEffect(() => {
    if (prevInitial.current === initialUnread) return;
    prevInitial.current = initialUnread;
    if (list) coalescer.current?.trigger();
  }, [initialUnread, list]);

  const available = useRealtimeAvailable();
  const realtimeStatus = useRealtimeStatus();
  // "connecting" também conta como sem tempo real; fora do provider (conta bloqueada) não há o que conferir
  const degraded = available && realtimeStatus !== "online";
  useEffect(() => {
    if (!degraded) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") coalescer.current?.trigger();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [degraded]);

  /** Ao abrir o sino: mostra o que já tem e atualiza (com "carregando" só na primeira vez). */
  const refresh = useCallback(() => {
    setNow(Date.now());
    void load(list === null);
  }, [load, list]);

  const mark = useCallback(
    async (target: ReadTarget) => {
      const p = pending.current;
      if (target.all) p.all = true;
      else for (const id of target.ids ?? []) p.ids.add(id);
      p.inflight += 1;
      setList((l) => (l ? markRead(l, target) : l));

      const body = target.all ? { all: true } : { ids: [...(target.ids ?? [])] };
      const result = await markNotificationsReadAction(body).catch(() => ({ error: "falhou" }) as const);

      p.inflight -= 1;
      if (p.inflight === 0) {
        p.all = false;
        p.ids.clear();
      }
      // a resposta de uma busca iniciada antes da gravação mostraria a notificação como não lida
      ticket.current += 1;
      if ("error" in result) {
        void load(false);
        return;
      }
      // sem outra gravação em andamento, o contador do servidor é a verdade
      if (p.inflight === 0) setList((l) => (l ? { ...l, unreadCount: result.unreadCount } : l));
      setBaseUnread(result.unreadCount);
    },
    [load],
  );

  const unread = list ? list.unreadCount : baseUnread;
  return useMemo(() => ({ list, unread, phase, now, refresh, retry: () => void load(true), mark }), [list, unread, phase, now, refresh, load, mark]);
}
