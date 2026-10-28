"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createCoalescer, type Coalescer } from "./coalesce";
import { useRealtimeEvent, useRealtimeResync, useRealtimeStatus } from "./hooks";
import { openConversationId, refreshRuleFor, shouldPoll } from "./routes";
import { getSoundEnabledSnapshot, playMessageSound, subscribeSoundEnabled } from "./sound";
import { withUnreadPrefix } from "./title";

/** No máximo um `router.refresh()` por janela, por tela. */
const REFRESH_WINDOW_MS = 400;
/** Sem tempo real, as telas se atualizam a cada tanto. */
const POLL_MS = 15_000;
/** Dois anúncios seguidos em menos que isso viram um só. */
const ANNOUNCE_GAP_MS = 2500;
const ANNOUNCEMENT = "Nova mensagem em uma conversa";

/**
 * Tudo o que reage aos avisos fora de uma tela específica: atualização da tela atual, polling de contingência,
 * contador no título da aba, som e anúncio para leitor de tela. Montado pelo `RealtimeProvider`.
 */
export function RealtimeEffects() {
  return (
    <>
      <RouteRefresher />
      <MessageNotifier />
    </>
  );
}

/** Aviso relevante para a tela atual → `router.refresh()` (juntando rajadas). Offline → refresh a cada 15 s. */
function RouteRefresher() {
  const router = useRouter();
  const pathname = usePathname();
  const status = useRealtimeStatus();
  const rule = useMemo(() => refreshRuleFor(pathname), [pathname]);
  const coalescer = useRef<Coalescer | null>(null);

  useEffect(() => {
    const defer = refreshRuleFor(pathname)?.deferWhileDialogOpen ?? false;
    const instance: Coalescer = createCoalescer(() => {
      // diálogo aberto (ex.: conectar canal por QR): tenta de novo daqui a pouco em vez de trocar a tela por baixo dele
      if (defer && document.querySelector('[role="dialog"][data-state="open"]')) instance.trigger();
      else router.refresh();
    }, REFRESH_WINDOW_MS);
    coalescer.current = instance;
    return () => {
      instance.cancel();
      coalescer.current = null;
    };
  }, [router, pathname]);

  useRealtimeEvent((event) => {
    if (rule?.types.has(event.type)) coalescer.current?.trigger();
  });

  // voltou depois de uma queda: uma atualização para pegar o que passou
  useRealtimeResync(() => {
    if (rule) coalescer.current?.trigger();
  });

  // "connecting" também conta: se a conexão não sobe, a tela ainda se atualiza (o intervalo de 15 s evita disparar à toa)
  const degraded = status !== "online";
  const poll = shouldPoll(pathname);
  useEffect(() => {
    if (!degraded || !poll) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") coalescer.current?.trigger();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [degraded, poll, pathname]);

  return null;
}

function useSoundEnabled(): boolean {
  return useSyncExternalStore(subscribeSoundEnabled, getSoundEnabledSnapshot, () => false);
}

/** Mensagem recebida: contador no título (aba escondida), som opcional e anúncio educado para leitor de tela. */
function MessageNotifier() {
  const pathname = usePathname();
  const params = useSearchParams();
  const openId = openConversationId(pathname, params);
  const soundOn = useSoundEnabled();
  const unread = useRef(0);
  const lastAnnounced = useRef(0);
  const [announcement, setAnnouncement] = useState({ tick: 0, text: "" });

  // título: reaplica o contador se o Next trocar o título (navegação, refresh) enquanto a aba está escondida
  useEffect(() => {
    const apply = () => {
      const wanted = withUnreadPrefix(document.title, unread.current);
      if (document.title !== wanted) document.title = wanted;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        unread.current = 0;
        apply();
      }
    };
    const observer = new MutationObserver(() => {
      if (unread.current > 0) apply();
    });
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      unread.current = 0;
      document.title = withUnreadPrefix(document.title, 0);
    };
  }, []);

  useRealtimeEvent((event) => {
    if (event.type !== "conversation.message" || event.direction !== "in") return;
    const hidden = document.visibilityState === "hidden";
    const isOpenAndVisible = !hidden && openId === event.conversationId;

    if (hidden) {
      unread.current += 1;
      document.title = withUnreadPrefix(document.title, unread.current);
    }
    // a conversa aberta já lê a mensagem nova (role="log"); evita falar duas vezes
    if (!isOpenAndVisible) {
      const now = Date.now();
      if (now - lastAnnounced.current > ANNOUNCE_GAP_MS) {
        lastAnnounced.current = now;
        setAnnouncement((prev) => ({ tick: prev.tick + 1, text: ANNOUNCEMENT }));
      }
      if (soundOn) playMessageSound();
    }
  });

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {/* a chave nova faz o leitor de tela falar de novo mesmo com o mesmo texto */}
      <span key={announcement.tick}>{announcement.text}</span>
    </div>
  );
}
