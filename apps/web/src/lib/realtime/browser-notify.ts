/**
 * Notificação do navegador (a janelinha do sistema) para mensagem nova quando a pessoa está em outra aba ou janela.
 * Desligada por padrão: ligar pede a permissão do navegador (só depois de um clique). A preferência fica no
 * `localStorage` (por navegador). O aviso em tempo real não carrega o texto da mensagem, então o conteúdo é genérico.
 * Todo acesso a storage e à API é protegido: modo privado ou navegador sem suporte não podem quebrar a tela.
 */
const KEY = "duckchat:browser-notify";
const CHANGE_EVENT = "duckchat:browser-notify-change";
const TAG = "duckchat-message";

let memoryFallback = false;

export type NotifyPermission = NotificationPermission | "unsupported";

export function notifyPermission(): NotifyPermission {
  try {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  } catch {
    return "unsupported";
  }
}

function readPreference(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return memoryFallback;
  }
}

function writePreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    memoryFallback = enabled;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Ligada = a pessoa quer E o navegador permitiu. Para `useSyncExternalStore`. */
export function getBrowserNotifyEnabledSnapshot(): boolean {
  return readPreference() && notifyPermission() === "granted";
}

export function subscribeBrowserNotify(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Chame dentro de um clique. Desligando, só guarda a preferência; ligando, pede a permissão se ainda não houver. */
export async function setBrowserNotifyEnabled(enabled: boolean): Promise<NotifyPermission> {
  if (!enabled) {
    writePreference(false);
    return notifyPermission();
  }
  let permission = notifyPermission();
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = notifyPermission();
    }
  }
  writePreference(permission === "granted");
  return permission;
}

/** A pessoa não está olhando o app agora (aba escondida ou outra janela em foco). */
export function isAway(): boolean {
  return document.visibilityState === "hidden" || !document.hasFocus();
}

/** Mostra "Nova mensagem". Uma única janelinha por vez (mesma `tag`): mensagens seguidas se juntam em vez de empilhar. */
export function showMessageNotification(onOpen: () => void): void {
  if (!getBrowserNotifyEnabledSnapshot()) return;
  try {
    const notification = new Notification("Nova mensagem", {
      body: "Um cliente respondeu no DuckChat.",
      tag: TAG,
      icon: "/apple-icon.png",
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      onOpen();
    };
  } catch {
    // alguns navegadores (celular) só aceitam via service worker: sem o aviso, o resto segue funcionando
  }
}
