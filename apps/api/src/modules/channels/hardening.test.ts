import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_MS, InMemoryQueue, setLongTimeout } from "./queue";
import { isSafeMediaUrl, isSafeMediaUrlResolved } from "./security";
import { minimizedEvent } from "./inbound-store";
import { readBodyLimited } from "./webhook";

afterEach(() => vi.useRealTimers());

describe("fila: atraso maior que 2^31-1 ms não dispara na hora", () => {
  it("setLongTimeout reagenda em etapas e só roda no fim", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const total = MAX_TIMER_MS * 2 + 5_000;
    setLongTimeout(run, total);
    vi.advanceTimersByTime(1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancel impede a execução", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const t = setLongTimeout(run, MAX_TIMER_MS + 10);
    t.cancel();
    vi.advanceTimersByTime(MAX_TIMER_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });

  it("InMemoryQueue com atraso gigante (campanha daqui a 60 dias) não executa imediatamente", async () => {
    vi.useFakeTimers();
    const queue = new InMemoryQueue<number>();
    const seen: number[] = [];
    queue.process("job", async (n) => {
      seen.push(n);
    });
    await queue.enqueue("job", 1, { delayMs: 60 * 86_400_000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(60 * 86_400_000);
    expect(seen).toEqual([1]);
  });
});

describe("corpo do webhook: limite no stream", () => {
  const streamOf = (chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });

  it("lê corpo pequeno", async () => {
    const req = new Request("https://x.test/", { method: "POST", body: '{"a":1}' });
    expect(await readBodyLimited(req, 100)).toBe('{"a":1}');
  });

  it("recusa corpo que passa do limite mesmo sem content-length (chunked)", async () => {
    const big = new Uint8Array(600).fill(97);
    const req = new Request("https://x.test/", { method: "POST", body: streamOf([big, big]), duplex: "half" } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    expect(await readBodyLimited(req, 1000)).toBeNull();
  });
});

describe("isSafeMediaUrl: ponto final, nomes internos e DNS", () => {
  it.each(["https://localhost./a", "https://postgres.internal./x", "https://metadata.google.internal./", "https://redis.local./", "https://[::1]/a", "https://127.0.0.1/a"])(
    "recusa %s",
    (u) => expect(isSafeMediaUrl(u)).toBe(false),
  );

  it("aceita host público; com resolvedor, recusa nome público que aponta para IP interno (nip.io)", async () => {
    expect(isSafeMediaUrl("https://cdn.exemplo.com.br/a.png")).toBe(true);
    const resolve = async (host: string) => (host.endsWith("nip.io") ? ["127.0.0.1"] : ["203.0.114.10"]);
    expect(await isSafeMediaUrlResolved("https://127.0.0.1.nip.io/a", resolve)).toBe(false);
    expect(await isSafeMediaUrlResolved("https://cdn.exemplo.com.br/a.png", resolve)).toBe(true);
    expect(await isSafeMediaUrlResolved("https://localhost./a", resolve)).toBe(false);
    expect(await isSafeMediaUrlResolved("https://sem-dns.exemplo.com/a", async () => { throw new Error("nxdomain"); })).toBe(false);
  });
});

describe("LGPD: evento minimizado não carrega dado pessoal", () => {
  it("guarda só tipo, marca e instante", () => {
    const m = minimizedEvent("message", { type: "message", from: "+5567988887777", name: "Maria", text: "meu CPF 123", at: "2026-10-26T12:00:00Z" });
    expect(m).toEqual({ minimized: true, type: "message", at: "2026-10-26T12:00:00Z" });
    expect(JSON.stringify(m)).not.toMatch(/5567|Maria|CPF/);
    expect(minimizedEvent("unparsed")).toEqual({ minimized: true, type: "unparsed" });
  });
});
