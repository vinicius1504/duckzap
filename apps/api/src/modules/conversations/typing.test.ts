import { describe, expect, it } from "vitest";
import type { MessagingProvider, OutboundMessage } from "../../lib/messaging";
import { loadChannelsConfig } from "../channels/config";
import { withoutUnsupportedTyping } from "../channels/sending";
import { ATTENDANT_TYPING_MIN_INTERVAL_MS, ATTENDANT_TYPING_MS, humanMayType, InMemoryTypingThrottle } from "./typing";

describe("InMemoryTypingThrottle: no máximo uma chamada por conversa a cada ~3,5 s (a tela renova a cada 4 s)", () => {
  it("o intervalo padrão fica logo abaixo da renovação da tela (4 s) e a duração abaixo do intervalo (sem paused atravessado)", () => {
    expect(ATTENDANT_TYPING_MIN_INTERVAL_MS).toBe(3500);
    expect(ATTENDANT_TYPING_MS).toBeLessThanOrEqual(ATTENDANT_TYPING_MIN_INTERVAL_MS);
  });

  it("libera a primeira, recusa dentro da janela e libera de novo depois dela", async () => {
    let now = 1000;
    const throttle = new InMemoryTypingThrottle({ now: () => now });
    expect(await throttle.allow("org:conv")).toBe(true);
    now += 3499;
    expect(await throttle.allow("org:conv")).toBe(false);
    now += 1;
    expect(await throttle.allow("org:conv")).toBe(true);
    now += 100;
    expect(await throttle.allow("org:conv")).toBe(false);
  });

  it("chaves diferentes não se afetam; chamada recusada não renova a janela", async () => {
    let now = 0;
    const throttle = new InMemoryTypingThrottle({ now: () => now });
    expect(await throttle.allow("a")).toBe(true);
    expect(await throttle.allow("b")).toBe(true);
    now = 3000;
    expect(await throttle.allow("a")).toBe(false); // recusada: não empurra o prazo
    now = 3500;
    expect(await throttle.allow("a")).toBe(true);
  });

  it("a memória é limitada (descarta as chaves mais antigas)", async () => {
    let now = 0;
    const throttle = new InMemoryTypingThrottle({ now: () => now, maxKeys: 3 });
    for (const key of ["a", "b", "c", "d"]) await throttle.allow(key);
    now = 1; // dentro da janela: a foi esquecida (liberada), d ainda lembrada (recusada)
    expect(await throttle.allow("a")).toBe(true);
    expect(await throttle.allow("d")).toBe(false);
  });
});

describe("humanMayType: só quando uma pessoa pode estar respondendo", () => {
  it("IA ativa respondendo sozinha e conversa resolvida: não", () => {
    expect(humanMayType({ mode: "ai", status: "ai_active" })).toBe(false);
    expect(humanMayType({ mode: "human", status: "resolved" })).toBe(false);
    expect(humanMayType({ mode: "ai", status: "resolved" })).toBe(false);
  });

  it("humano, fila de atendimento e copiloto: sim", () => {
    expect(humanMayType({ mode: "human", status: "human_active" })).toBe(true);
    expect(humanMayType({ mode: "human", status: "handoff_requested" })).toBe(true);
    expect(humanMayType({ mode: "ai", status: "handoff_requested" })).toBe(true);
    expect(humanMayType({ mode: "copilot", status: "human_active" })).toBe(true);
    expect(humanMayType({ mode: "copilot", status: "ai_active" })).toBe(true);
  });
});

describe("withoutUnsupportedTyping: typingMs só chega a provedor com presença", () => {
  const message: OutboundMessage = { externalId: "e", to: "+5567999990000", kind: "text", text: "oi", typingMs: 2000 };
  const provider = (presence: boolean): Pick<MessagingProvider, "capabilities"> => ({
    capabilities: () => ({ buttons: false, lists: false, templates: false, media: true, reactions: false, window24h: false, presence }),
  });

  it("com a capacidade, mantém", () => {
    expect(withoutUnsupportedTyping(provider(true), message)).toBe(message);
  });
  it("sem a capacidade, remove só o typingMs", () => {
    const out = withoutUnsupportedTyping(provider(false), message);
    expect(out).toEqual({ externalId: "e", to: "+5567999990000", kind: "text", text: "oi" });
    expect(out).not.toHaveProperty("typingMs");
    expect(message.typingMs).toBe(2000); // não muta o original
  });
  it("sem typingMs, devolve a mesma mensagem", () => {
    const plain: OutboundMessage = { externalId: "e", to: "+5567999990000", kind: "text", text: "oi" };
    expect(withoutUnsupportedTyping(provider(false), plain)).toBe(plain);
  });
});

describe("PRESENCE_ENABLED / PRESENCE_WEBHOOK_SYNC (config do módulo Canais)", () => {
  it("padrão: ligados", () => {
    const config = loadChannelsConfig({});
    expect(config.presenceEnabled).toBe(true);
    expect(config.presenceWebhookSync).toBe(true);
  });

  it("false/0/nao desligam; vazio volta ao padrão; variantes de caixa", () => {
    for (const value of ["false", "FALSE", "0", "nao", "não", "off"]) expect(loadChannelsConfig({ PRESENCE_ENABLED: value }).presenceEnabled).toBe(false);
    for (const value of ["true", "True", "1", "sim", ""]) expect(loadChannelsConfig({ PRESENCE_ENABLED: value }).presenceEnabled).toBe(true);
  });

  it("PRESENCE_ENABLED=false desliga também a sincronização do webhook", () => {
    expect(loadChannelsConfig({ PRESENCE_ENABLED: "false" }).presenceWebhookSync).toBe(false);
    expect(loadChannelsConfig({ PRESENCE_WEBHOOK_SYNC: "false" })).toMatchObject({ presenceEnabled: true, presenceWebhookSync: false });
  });

  it("valor inválido derruba o boot com erro (nada de ligar/desligar por engano)", () => {
    expect(() => loadChannelsConfig({ PRESENCE_ENABLED: "talvez" })).toThrow();
  });
});
