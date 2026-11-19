"use client";

import type { MemberRole } from "@duckzap/contracts/session";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { isWorthShowing, resolveTourSteps, shouldStartTour, stepsForRole, TOUR_HOME_PATH, TOUR_QUERY, tourSeenKey } from "../steps";

/** Pedido para rodar o tour agora, na página atual (botão no cartão Primeiros passos). */
export const TOUR_START_EVENT = "duckchat:tour-start";

export function requestTour() {
  window.dispatchEvent(new Event(TOUR_START_EVENT));
}

// "Já vi" por navegador e por pessoa, como as outras preferências locais. localStorage pode falhar (modo privado,
// bloqueado): aí o tour pode aparecer de novo no próximo acesso, o que é aceitável.
function readSeen(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function markSeen(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // ignora
  }
}

/** Primeiro elemento visível com a âncora: o mesmo item existe no rail (computador) e na tab bar (celular). */
function visibleAnchor(anchor: string): Element | null {
  for (const element of document.querySelectorAll(`[data-tour="${CSS.escape(anchor)}"]`)) {
    if (element.getClientRects().length > 0) return element;
  }
  return null;
}

/** Diálogo, menu ou confirmação aberta: o tour não abre por cima. */
function somethingOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"]:not(.driver-popover), [role="alertdialog"], [role="menu"], dialog[open]'));
}

const START_DELAY_MS = 700;
const RETRY_MS = 1000;
const MAX_RETRIES = 15;

/**
 * Tour guiado na primeira entrada no Início (dono/admin: menu e Primeiros passos; atendente: conversas e ajuda).
 * Montado no shell só com a conta liberada: o layout já manda para /comecar e para o 2FA antes de chegar aqui.
 * driver.js entra por import dinâmico, só quando o tour vai rodar.
 */
export function ProductTour({ userId, role }: { userId: string; role: MemberRole }) {
  const pathname = usePathname();
  const forced = useSearchParams().get(TOUR_QUERY) === "1";
  const stopRef = useRef<(() => void) | null>(null);
  const key = tourSeenKey(userId);

  // trocou de página (ou saiu do app): fecha o tour aberto
  useEffect(
    () => () => {
      stopRef.current?.();
      stopRef.current = null;
    },
    [pathname],
  );

  useEffect(() => {
    if (pathname !== TOUR_HOME_PATH) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function attempt(force: boolean, tries: number) {
      if (cancelled || stopRef.current) return;
      if (somethingOpen()) {
        if (tries < MAX_RETRIES) timer = setTimeout(() => void attempt(force, tries + 1), RETRY_MS);
        return;
      }
      const steps = resolveTourSteps(stepsForRole(role), (anchor) => visibleAnchor(anchor) !== null);
      if (!isWorthShowing(steps)) return;

      const { runTour } = await import("../tour-runner");
      if (cancelled || stopRef.current || somethingOpen()) return;

      markSeen(key);
      if (force && new URLSearchParams(window.location.search).has(TOUR_QUERY)) {
        // tira o ?tour=1 da barra: recarregar não repete o tour
        window.history.replaceState(window.history.state, "", TOUR_HOME_PATH);
      }
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      // resolve de novo na hora: a tela pode ter mudado durante o carregamento
      const resolved = resolveTourSteps(steps, (anchor) => visibleAnchor(anchor) !== null).map((step) => ({
        step,
        element: step.anchor ? visibleAnchor(step.anchor) : null,
      }));
      if (!isWorthShowing(resolved.map((r) => r.step))) return;
      stopRef.current = runTour(resolved, {
        reducedMotion,
        onEnd: () => {
          stopRef.current = null;
        },
      });
    }

    function schedule(force: boolean) {
      clearTimeout(timer);
      timer = setTimeout(() => void attempt(force, 0), START_DELAY_MS);
    }

    if (shouldStartTour({ pathname, seen: readSeen(key), forced, blocked: false })) schedule(forced);

    const onRequest = () => schedule(true);
    window.addEventListener(TOUR_START_EVENT, onRequest);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener(TOUR_START_EVENT, onRequest);
    };
  }, [pathname, forced, role, key]);

  return null;
}
