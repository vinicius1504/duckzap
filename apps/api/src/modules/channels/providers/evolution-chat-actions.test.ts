import { describe, expect, it } from "vitest";
import { ProviderError, type ChannelRef } from "../../../lib/messaging";
import { EvolutionProvider } from "./evolution";
import type { FetchLike } from "./shared";

/** Ações sobre a conversa via Evolution: marcar como lida, foto de perfil e conferir número. Dados inventados. */

const channel: ChannelRef = {
  id: "c1",
  organizationId: "org_a",
  credentials: { instanceName: "dz-test-instance", webhookSecret: "dzes_secret_value_123", instanceToken: "INSTANCE-TOKEN-0001" },
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function setup(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call);
  };
  return { provider: new EvolutionProvider({ baseUrl: "http://evolution.test", apiKey: "GLOBAL-KEY-0001", fetch }), calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof ProviderError ? error.code : "other"),
  );

describe("Evolution: markAsRead", () => {
  it("POST /chat/markMessageAsRead com o jid do cliente e fromMe=false, sem ids repetidos", async () => {
    const { provider, calls } = setup(() => json({ message: "ok" }));
    await provider.markAsRead(channel, { to: "+55 (67) 99999-0000", messageIds: ["A1", "A2", "A1"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://evolution.test/chat/markMessageAsRead/dz-test-instance",
      method: "POST",
      body: {
        readMessages: [
          { remoteJid: "5567999990000@s.whatsapp.net", fromMe: false, id: "A1" },
          { remoteJid: "5567999990000@s.whatsapp.net", fromMe: false, id: "A2" },
        ],
      },
    });
    expect(calls[0]!.headers.apikey).toBe("INSTANCE-TOKEN-0001");
  });

  it("sem mensagens ou com número inválido não chama a Evolution", async () => {
    const { provider, calls } = setup(() => json({}));
    await provider.markAsRead(channel, { to: "5567999990000", messageIds: [] });
    await provider.markAsRead(channel, { to: "123", messageIds: ["A1"] });
    expect(calls).toHaveLength(0);
  });

  it("manda no máximo 20 mensagens por chamada", async () => {
    const { provider, calls } = setup(() => json({}));
    await provider.markAsRead(channel, { to: "5567999990000", messageIds: Array.from({ length: 30 }, (_, i) => `M${i}`) });
    expect((calls[0]!.body as { readMessages: unknown[] }).readMessages).toHaveLength(20);
  });

  it("401/403 = desconectado; 429/5xx = indisponível; outros 4xx = recusado", async () => {
    const code = async (status: number) => {
      const { provider } = setup(() => json({}, status));
      return codeOf(provider.markAsRead(channel, { to: "5567999990000", messageIds: ["A1"] }));
    };
    expect(await code(401)).toBe("invalid_credentials");
    expect(await code(403)).toBe("invalid_credentials");
    expect(await code(429)).toBe("unavailable");
    expect(await code(500)).toBe("unavailable");
    expect(await code(400)).toBe("rejected");
  });
});

describe("Evolution: fetchProfilePicture", () => {
  it("POST /chat/fetchProfilePictureUrl com só os dígitos e devolve a URL https", async () => {
    const { provider, calls } = setup(() => json({ wuid: "5567999990000@s.whatsapp.net", profilePictureUrl: "https://pps.whatsapp.net/v/a.jpg?oh=1" }));
    expect(await provider.fetchProfilePicture(channel, { to: "+55 67 99999-0000" })).toBe("https://pps.whatsapp.net/v/a.jpg?oh=1");
    expect(calls[0]).toMatchObject({ url: "http://evolution.test/chat/fetchProfilePictureUrl/dz-test-instance", method: "POST", body: { number: "5567999990000" } });
  });

  it("sem foto, foto privada, URL que não é https, número desconhecido (400/404) e número curto = null", async () => {
    const run = async (respond: () => Response, to = "5567999990000") => setup(respond).provider.fetchProfilePicture(channel, { to });
    expect(await run(() => json({ wuid: "x", profilePictureUrl: null }))).toBeNull();
    expect(await run(() => json({ wuid: "x" }))).toBeNull();
    expect(await run(() => json({ profilePictureUrl: "http://pps.whatsapp.net/a.jpg" }))).toBeNull();
    expect(await run(() => json({}, 400))).toBeNull();
    expect(await run(() => json({}, 404))).toBeNull();
    const { provider, calls } = setup(() => json({}));
    expect(await provider.fetchProfilePicture(channel, { to: "12" })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("401 = desconectado; 500 = indisponível", async () => {
    const code = async (status: number) => codeOf(setup(() => json({}, status)).provider.fetchProfilePicture(channel, { to: "5567999990000" }));
    expect(await code(401)).toBe("invalid_credentials");
    expect(await code(500)).toBe("unavailable");
  });
});

describe("Evolution: checkNumbers", () => {
  it("POST /chat/whatsappNumbers e normaliza: quem existe traz o jid, quem não existe vem sem jid", async () => {
    const { provider, calls } = setup(() =>
      json([
        { exists: true, jid: "5567999990000@s.whatsapp.net", number: "5567999990000" },
        { exists: false, jid: "5511988880000@s.whatsapp.net", number: "5511988880000" },
      ]),
    );
    const result = await provider.checkNumbers(channel, { numbers: ["+55 67 99999-0000", "(11) 98888-0000", "5567999990000", "12"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "http://evolution.test/chat/whatsappNumbers/dz-test-instance", method: "POST", body: { numbers: ["5567999990000", "11988880000"] } });
    expect(result).toEqual([
      { number: "5567999990000", exists: true, jid: "5567999990000@s.whatsapp.net" },
      { number: "5511988880000", exists: false, jid: null },
    ]);
  });

  it("lista vazia ou só de números inválidos não chama a Evolution", async () => {
    const { provider, calls } = setup(() => json([]));
    expect(await provider.checkNumbers(channel, { numbers: [] })).toEqual([]);
    expect(await provider.checkNumbers(channel, { numbers: ["1", "abc"] })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("limita a 50 números por chamada", async () => {
    const { provider, calls } = setup(() => json([]));
    await provider.checkNumbers(channel, { numbers: Array.from({ length: 80 }, (_, i) => `55679999${String(i).padStart(5, "0")}`) });
    expect((calls[0]!.body as { numbers: string[] }).numbers).toHaveLength(50);
  });

  it("resposta fora do formato = indisponível; itens soltos são ignorados", async () => {
    expect(await codeOf(setup(() => json({ error: "x" })).provider.checkNumbers(channel, { numbers: ["5567999990000"] }))).toBe("unavailable");
    const { provider } = setup(() => json([null, "x", { exists: true }, { exists: true, jid: "5567999990000@s.whatsapp.net" }]));
    expect(await provider.checkNumbers(channel, { numbers: ["5567999990000"] })).toEqual([{ number: "5567999990000", exists: true, jid: "5567999990000@s.whatsapp.net" }]);
  });

  it("401 = desconectado; 500 = indisponível", async () => {
    const code = async (status: number) => codeOf(setup(() => json({}, status)).provider.checkNumbers(channel, { numbers: ["5567999990000"] }));
    expect(await code(401)).toBe("invalid_credentials");
    expect(await code(500)).toBe("unavailable");
  });
});
