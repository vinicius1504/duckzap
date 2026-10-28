import { CAMPAIGN_VARIABLES, fillVariables, type CampaignMessage } from "@duckzap/contracts/campaigns";
import { shuffle, type Rng } from "./rng";

// Texto que de fato vai para o contato (§5.7 item 4): variação sorteada sem repetir em seguida, variáveis do contato,
// opções numeradas quando o provedor não tem botões/listas, e a linha de saída SEMPRE no fim.

export type BankEntry = { id: string; text: string };

/**
 * Sorteio "saco embaralhado": cada variação sai uma vez antes de qualquer uma repetir, e a primeira do saco novo nunca
 * é a última usada. Garante que a mesma variação nunca sai em duas mensagens seguidas (com 2+ variações).
 */
export function drawFromBag(
  approved: readonly BankEntry[],
  bag: readonly string[],
  lastId: string | null,
  rng: Rng,
): { entry: BankEntry; bag: string[] } | null {
  if (approved.length === 0) return null;
  const valid = new Set(approved.map((v) => v.id));
  let pool = bag.filter((id) => valid.has(id));
  if (pool.length === 0) {
    pool = shuffle(
      approved.map((v) => v.id),
      rng,
    );
    if (pool.length > 1 && pool[0] === lastId) {
      const swapWith = 1 + Math.floor(rng() * (pool.length - 1));
      const first = pool[0] as string;
      pool[0] = pool[swapWith] as string;
      pool[swapWith] = first;
    }
  }
  const [id, ...rest] = pool;
  const entry = approved.find((v) => v.id === id);
  if (!entry) return null;
  return { entry, bag: rest };
}

/** Garante a linha de saída no fim (§5.7 item 4: toda mensagem termina com opção de saída). */
export function ensureOptOut(text: string, optOutLine: string) {
  const line = optOutLine.trim();
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(line)) return trimmed;
  return `${trimmed}\n\n${line}`;
}

/** Opções numeradas no lugar de botões/lista (provedor sem suporte, §3.6). Entram ANTES da linha de saída. */
export function degradeToText(message: Pick<CampaignMessage, "type" | "buttons" | "listButtonLabel" | "listItems">): string | null {
  if (message.type === "buttons" && message.buttons.length) {
    return `Responda com o número:\n${message.buttons.map((b, i) => `${i + 1}) ${b}`).join("\n")}`;
  }
  if (message.type === "list" && message.listItems.length) {
    const title = message.listButtonLabel.trim() || "Escolha uma opção";
    return `${title} (responda com o número):\n${message.listItems
      .map((item, i) => `${i + 1}) ${item.title}${item.description.trim() ? ` — ${item.description.trim()}` : ""}`)
      .join("\n")}`;
  }
  return null;
}

/** Corpo + opções numeradas, sempre terminando na linha de saída. */
export function composeBody(text: string, optOutLine: string, extras: string | null) {
  const line = optOutLine.trim();
  let body = text.trimEnd();
  if (body.endsWith(line)) body = body.slice(0, body.length - line.length).trimEnd();
  return `${body}${extras ? `\n\n${extras}` : ""}\n\n${line}`;
}

export type ContactVariables = { name: string | null; orgName: string; lastVisit: string | null };

/** Primeiro nome; nome que é só o telefone vira "cliente" para a mensagem não sair com número no lugar do nome. */
export function firstName(name: string | null) {
  const trimmed = (name ?? "").trim();
  if (!trimmed || /^[+\d\s()-]+$/.test(trimmed)) return "cliente";
  return trimmed.split(/\s+/)[0] ?? "cliente";
}

/** Substitui {nome}, {empresa}, {ultima_visita}. Nenhuma variável conhecida sai crua na mensagem. */
export function renderVariables(text: string, contact: ContactVariables) {
  const values: Record<string, string> = {
    "{nome}": firstName(contact.name),
    "{empresa}": contact.orgName,
    "{ultima_visita}": contact.lastVisit ?? "recentemente",
  };
  return fillVariables(text, values);
}

/** Variável que sobrou sem valor (ex.: {cidade}) — o envio é barrado em vez de mandar chaves ao cliente. */
export function hasUnresolvedVariable(rendered: string) {
  return /\{[a-z_]+\}/.test(rendered);
}

export const KNOWN_VARIABLES: readonly string[] = CAMPAIGN_VARIABLES;
