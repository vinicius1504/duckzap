import type { PageEnv, PageSignal, SocketFactory } from "./client";

/** `new WebSocket` por trás da interface pequena que o `RealtimeClient` usa. */
export const browserSocketFactory: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => handlers.onOpen());
  ws.addEventListener("message", (event: MessageEvent) => handlers.onMessage(event.data));
  // `error` sempre é seguido de `close`; é o `close` que decide o que fazer
  ws.addEventListener("close", (event: CloseEvent) => handlers.onClose(event.code));
  return {
    send: (data) => ws.send(data),
    close: (code) => {
      // fecha antes de abrir só gera aviso no console; ignoramos o que chegar depois
      try {
        ws.close(code);
      } catch {
        // já fechado
      }
    },
  };
};

/** Sinais da página: aba visível/escondida e rede. */
export const browserPageEnv: PageEnv = {
  isHidden: () => document.visibilityState === "hidden",
  subscribe(listener) {
    const onVisibility = () => listener(document.visibilityState === "hidden" ? "hidden" : "visible");
    const emit = (signal: PageSignal) => () => listener(signal);
    const onOnline = emit("online");
    const onOffline = emit("offline");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  },
};
