import { describe, expect, it, vi } from "vitest";
import { createTypingPinger, TYPING_PING_INTERVAL_MS } from "./typing-pinger";

function setup() {
  let time = 10_000;
  const send = vi.fn();
  const pinger = createTypingPinger({ send, now: () => time });
  return { send, pinger, advance: (ms: number) => void (time += ms) };
}

describe("createTypingPinger", () => {
  it("o intervalo padrão é de ~4 s", () => {
    expect(TYPING_PING_INTERVAL_MS).toBe(4000);
  });

  it("o primeiro toque avisa na hora; os seguintes dentro de 4 s não", () => {
    const { pinger, send, advance } = setup();
    expect(pinger.input("o")).toBe(true);
    advance(300);
    expect(pinger.input("ol")).toBe(false);
    advance(3000);
    expect(pinger.input("ola")).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("enquanto continua digitando, renova a cada 4 s", () => {
    const { pinger, send, advance } = setup();
    pinger.input("a");
    advance(4000);
    expect(pinger.input("ab")).toBe(true);
    advance(3999);
    expect(pinger.input("abc")).toBe(false);
    advance(1);
    expect(pinger.input("abcd")).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("texto vazio (ou só espaços) não avisa e zera a sequência", () => {
    const { pinger, send, advance } = setup();
    expect(pinger.input("")).toBe(false);
    expect(pinger.input("   ")).toBe(false);
    expect(send).not.toHaveBeenCalled();
    pinger.input("a");
    advance(500);
    pinger.input(""); // apagou tudo
    advance(500);
    expect(pinger.input("b")).toBe(true); // recomeçou: avisa de novo na hora
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("stop() (enviar / sair do campo) faz o próximo toque avisar de novo na hora", () => {
    const { pinger, send, advance } = setup();
    pinger.input("a");
    advance(100);
    pinger.stop();
    expect(pinger.input("b")).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("desabilitado (nota interna, envio pausado, IA respondendo) nunca avisa", () => {
    const { pinger, send } = setup();
    expect(pinger.input("nota para a equipe", false)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
