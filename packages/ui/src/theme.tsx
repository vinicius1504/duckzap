"use client";

import { useCallback, useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";

const storageKey = "duckzap-theme";
const listeners = new Set<() => void>();

/**
 * Roda no <head> antes da pintura: aplica o tema salvo sem piscar.
 * "system" não define data-theme e deixa o CSS seguir prefers-color-scheme.
 */
export const themeInitScript = `(function(){try{var t=localStorage.getItem("${storageKey}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();`;

function read(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function apply(theme: ThemePreference) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, read, () => "system" as const);

  const setTheme = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, next);
    } catch {
      // sem storage (aba privada): aplica só nesta visita
    }
    apply(next);
    listeners.forEach((listener) => listener());
  }, []);

  return { theme, setTheme };
}
