"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { browserPageEnv, browserSocketFactory } from "./browser";
import { RealtimeClient } from "./client";
import { RealtimeEffects } from "./effects";
import { RealtimeContext } from "./hooks";
import { resolveRealtimeUrl } from "./protocol";

function createBrowserClient(): RealtimeClient {
  return new RealtimeClient({
    // lazy: só é lido ao conectar (no navegador), nunca durante o render no servidor
    url: () =>
      resolveRealtimeUrl({
        envUrl: process.env.NEXT_PUBLIC_REALTIME_URL,
        isDev: process.env.NODE_ENV === "development",
        location: window.location,
      }),
    createSocket: browserSocketFactory,
    page: browserPageEnv,
  });
}

/**
 * Abre UMA conexão de tempo real para toda a área logada. Monte uma vez, no layout, e só quando a conta
 * não está bloqueada (suspensa / 2FA pendente). Os avisos chegam por `useRealtimeEvent`.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [client] = useState(createBrowserClient);

  useEffect(() => {
    const offFatal = client.onFatal((reason, code) => {
      if (reason === "forbidden_origin") {
        console.warn(`[realtime] conexão recusada (${code}): origem não permitida. Confira NEXT_PUBLIC_REALTIME_URL e a lista de origens do servidor.`);
        return;
      }
      // sessão inválida ou conta suspensa: não reconecta; o refresh faz o layout redirecionar ao login / mostrar a tela de suspensão
      router.refresh();
    });
    // adia a abertura para depois do ciclo montar→desmontar→montar do StrictMode (evita abrir e fechar um socket à toa)
    const timer = setTimeout(() => client.start(), 0);
    return () => {
      clearTimeout(timer);
      offFatal();
      client.stop();
    };
  }, [client, router]);

  return (
    <RealtimeContext.Provider value={client}>
      {children}
      <Suspense fallback={null}>
        <RealtimeEffects />
      </Suspense>
    </RealtimeContext.Provider>
  );
}
