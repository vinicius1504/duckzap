"use client";

import { Chip } from "@duckzap/ui/components/chip";
import { cn } from "@duckzap/ui/cn";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useRealtimeAvailable, useRealtimeStatus } from "./hooks";
import {
  getBrowserNotifyEnabledSnapshot,
  notifyPermission,
  setBrowserNotifyEnabled,
  subscribeBrowserNotify,
} from "./browser-notify";
import { getSoundEnabledSnapshot, primeSound, subscribeSoundEnabled, writeSoundEnabled } from "./sound";

/** Só mostra depois de tanto tempo fora do ar (quedas curtas e a primeira conexão passam em silêncio). */
const SHOW_AFTER_MS = 5000;

/** "Reconectando…" discreto, na barra do topo, quando o tempo real está fora do ar há mais de ~5 s. */
export function RealtimeStatusChip() {
  const available = useRealtimeAvailable();
  const status = useRealtimeStatus();
  // "connecting" e "offline" alternam a cada tentativa: o que importa é não estar online
  const degraded = status !== "online";
  const [late, setLate] = useState(false);

  useEffect(() => {
    if (!degraded) return;
    const timer = setTimeout(() => setLate(true), SHOW_AFTER_MS);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [degraded]);

  if (!available || !degraded || !late) return null;
  return (
    <Chip tone="warn" role="status" title="A conexão em tempo real caiu. As telas continuam se atualizando a cada poucos segundos.">
      <span className="size-2 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true" />
      Reconectando…
    </Chip>
  );
}

/** Liga/desliga a janelinha do navegador para mensagem nova (pede a permissão ao ligar). Some se o navegador não suporta. */
export function BrowserNotifyToggle({ className }: { className?: string }) {
  const available = useRealtimeAvailable();
  const enabled = useSyncExternalStore(subscribeBrowserNotify, getBrowserNotifyEnabledSnapshot, () => false);
  const permission = useSyncExternalStore(subscribeBrowserNotify, notifyPermission, () => "unsupported" as const);
  if (!available || permission === "unsupported") return null;

  const blocked = permission === "denied";
  const title = blocked
    ? "Avisos do navegador bloqueados. Libere as notificações deste site nas configurações do navegador."
    : enabled
      ? "Avisos do navegador: ligados (aparecem quando você está em outra aba)"
      : "Avisos do navegador: desligados";

  return (
    <button
      type="button"
      aria-pressed={enabled}
      aria-label="Avisos do navegador para novas mensagens"
      title={title}
      disabled={blocked}
      onClick={() => void setBrowserNotifyEnabled(!enabled)}
      className={cn(
        "flex size-10 items-center justify-center rounded-control border border-line bg-surface hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
        {enabled ? <path d="m9 10 2 2 4-4" /> : null}
      </svg>
    </button>
  );
}

/** Liga/desliga o som de nova mensagem (guardado no navegador, desligado por padrão). */
export function SoundToggle({ className }: { className?: string }) {
  const available = useRealtimeAvailable();
  const enabled = useSyncExternalStore(subscribeSoundEnabled, getSoundEnabledSnapshot, () => false);
  if (!available) return null;

  return (
    <button
      type="button"
      aria-pressed={enabled}
      aria-label="Som de novas mensagens"
      title={enabled ? "Som de novas mensagens: ligado" : "Som de novas mensagens: desligado"}
      onClick={() => {
        if (!enabled) primeSound(); // o clique libera o áudio no navegador
        writeSoundEnabled(!enabled);
      }}
      className={cn("flex size-10 items-center justify-center rounded-control border border-line bg-surface hover:bg-surface-hover", className)}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M11 5 6 9H3v6h3l5 4V5z" />
        {enabled ? (
          <>
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M18.5 5.5a9 9 0 0 1 0 13" />
          </>
        ) : (
          <>
            <path d="m16 9 5 6" />
            <path d="m21 9-5 6" />
          </>
        )}
      </svg>
    </button>
  );
}
