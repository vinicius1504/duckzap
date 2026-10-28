"use client";

import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Toast = { id: number; tone: "ok" | "err"; text: string };

const ToastContext = createContext<(tone: Toast["tone"], text: string) => void>(() => {});

/** Aviso curto depois de uma ação ("Plano alterado. Registrado na auditoria."). */
export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((tone: Toast["tone"], text: string) => {
    setToast({ id: Date.now(), tone, text });
  }, []);

  useEffect(() => {
    if (!toast) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 7000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-6 z-[60] flex justify-end max-md:bottom-24 md:left-auto md:right-6"
      >
        {toast ? (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-card border border-line bg-surface p-4 shadow-lg",
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
                toast.tone === "ok" ? "bg-ok-bg text-ok" : "bg-err-bg text-err",
              )}
            >
              <Icon name={toast.tone === "ok" ? "check" : "alert"} size={14} strokeWidth={2.4} />
            </span>
            <p className="flex-1 font-semibold">{toast.text}</p>
            <button
              type="button"
              aria-label="Fechar aviso"
              onClick={() => setToast(null)}
              className="-m-2 flex size-10 shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-surface-hover"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}
