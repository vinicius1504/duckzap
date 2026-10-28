import { describe, expect, it } from "vitest";
import { ProviderError, type ChannelRef } from "../../../lib/messaging";
import { EvolutionProvider, classifyEvolutionContact } from "./evolution";
import type { FetchLike } from "./shared";

/** Lista de contatos da Evolution (`findContacts`): formato do pedido e classificação. Dados abaixo são todos inventados. */

const channel: ChannelRef = {
  id: "c1",
  organizationId: "org_a",
  credentials: { instanceName: "dz-test-instance", webhookSecret: "dzes_secret_value_123", instanceToken: "INSTANCE-TOKEN-0001" },
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function setup(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { provider: new EvolutionProvider({ baseUrl: "http://evolution.test", apiKey: "GLOBAL-KEY-0001", fetch }), calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Evolution: classifyEvolutionContact", () => {
  it("@s.whatsapp.net com 8–15 dígitos é pessoa; guarda só os dígitos", () => {
    expect(classifyEvolutionContact({ remoteJid: "5567999990000@s.whatsapp.net", pushName: "Ana Souza" })).toEqual({
      jid: "5567999990000@s.whatsapp.net",
      kind: "person",
      phoneDigits: "5567999990000",
      name: "Ana Souza",
    });
    // 12 dígitos (formato antigo, sem o 9) e 13 dígitos (com o 9) são JIDs reais
    expect(classifyEvolutionContact({ remoteJid: "556799990000@s.whatsapp.net", pushName: "Bia" })).toMatchObject({ kind: "person", phoneDigits: "556799990000" });
    expect(classifyEvolutionContact({ remoteJid: "5567999990001@s.whatsapp.net", pushName: "Caio" })).toMatchObject({ kind: "person", phoneDigits: "5567999990001" });
    expect(classifyEvolutionContact({ remoteJid: "12025550123@s.whatsapp.net", pushName: "Dan" })).toMatchObject({ kind: "person", phoneDigits: "12025550123" });
  });

  it("sufixo de dispositivo (:12) não entra no número", () => {
    expect(classifyEvolutionContact({ remoteJid: "5567999990000:12@s.whatsapp.net" })).toMatchObject({ kind: "person", phoneDigits: "5567999990000" });
  });

  it("0@s.whatsapp.net e números fora de 8–15 dígitos viram other", () => {
    expect(classifyEvolutionContact({ remoteJid: "0@s.whatsapp.net", pushName: "WhatsApp" })).toMatchObject({ kind: "other", phoneDigits: null });
    expect(classifyEvolutionContact({ remoteJid: "1234567@s.whatsapp.net" })).toMatchObject({ kind: "other", phoneDigits: null });
    expect(classifyEvolutionContact({ remoteJid: "1234567890123456@s.whatsapp.net" })).toMatchObject({ kind: "other", phoneDigits: null });
    expect(classifyEvolutionContact({ remoteJid: "abc@s.whatsapp.net" })).toMatchObject({ kind: "other" });
  });

  it("grupo, ID oculto (@lid) e transmissão/status não são pessoas", () => {
    expect(classifyEvolutionContact({ remoteJid: "120363000000000001@g.us", pushName: "Família" })).toMatchObject({ kind: "group", phoneDigits: null });
    expect(classifyEvolutionContact({ remoteJid: "98765432109876@lid", pushName: null })).toMatchObject({ kind: "hidden", phoneDigits: null, name: null });
    expect(classifyEvolutionContact({ remoteJid: "status@broadcast" })).toMatchObject({ kind: "other" });
    expect(classifyEvolutionContact({ remoteJid: "5567999990000@broadcast" })).toMatchObject({ kind: "other" });
    expect(classifyEvolutionContact({ remoteJid: "120363000000000002@newsletter" })).toMatchObject({ kind: "other" });
  });

  it("nome: apara; vazio ou só dígitos/símbolos de telefone vira null", () => {
    const named = (pushName: unknown) => classifyEvolutionContact({ remoteJid: "5567999990000@s.whatsapp.net", pushName }).name;
    expect(named("  Ana  ")).toBe("Ana");
    expect(named("")).toBeNull();
    expect(named("   ")).toBeNull();
    expect(named(null)).toBeNull();
    expect(named(undefined)).toBeNull();
    expect(named(42)).toBeNull();
    expect(named("5567999990000")).toBeNull();
    expect(named("+55 67 99999-0000")).toBeNull();
    expect(named("+55 (67) 9999.0000")).toBeNull();
    expect(named("‪+55 67 99999-0000‬")).toBeNull();
    expect(named("+")).toBeNull();
    // tem letra ou emoji: é nome
    expect(named("Loja 24h")).toBe("Loja 24h");
    expect(named("Ana 2")).toBe("Ana 2");
    expect(named("👍")).toBe("👍");
  });

  it("item estranho (sem jid, não-objeto) nunca lança", () => {
    for (const item of [null, undefined, "x", 3, [], {}, { remoteJid: 5 }, { remoteJid: "semarroba" }]) {
      expect(classifyEvolutionContact(item)).toMatchObject({ kind: "other", phoneDigits: null });
    }
  });

  it("ignora isSaved/type: não distinguem nada na Evolution", () => {
    const a = classifyEvolutionContact({ remoteJid: "5567999990000@s.whatsapp.net", pushName: "Ana", isSaved: true, type: "contact" });
    const b = classifyEvolutionContact({ remoteJid: "5567999990000@s.whatsapp.net", pushName: "Ana", isSaved: false, type: "group" });
    expect(a).toEqual(b);
  });
});

describe("Evolution: listContacts", () => {
  it("POST /chat/findContacts/{instância} com { where: {} } e a chave da instância", async () => {
    const { provider, calls } = setup(() => json([{ remoteJid: "5567999990000@s.whatsapp.net", pushName: "Ana" }]));
    const out = await provider.listContacts(channel);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://evolution.test/chat/findContacts/dz-test-instance");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.apikey).toBe("INSTANCE-TOKEN-0001");
    expect(calls[0]!.body).toEqual({ where: {} });
    expect(out).toEqual([{ jid: "5567999990000@s.whatsapp.net", kind: "person", phoneDigits: "5567999990000", name: "Ana" }]);
  });

  it("sem token da instância usa a chave global", async () => {
    const { provider, calls } = setup(() => json([]));
    await provider.listContacts({ ...channel, credentials: { instanceName: "dz-test-instance" } });
    expect(calls[0]!.headers.apikey).toBe("GLOBAL-KEY-0001");
  });

  it("dá conta de uma resposta grande (milhares de itens) e mistura de tipos", async () => {
    const items = [
      ...Array.from({ length: 3000 }, (_, i) => ({ remoteJid: `55679${String(10_000_000 + i)}@s.whatsapp.net`, pushName: `Pessoa ${i}`, isSaved: true, type: "contact" })),
      ...Array.from({ length: 50 }, (_, i) => ({ remoteJid: `1203630000000${String(i).padStart(5, "0")}@g.us`, pushName: `Grupo ${i}` })),
      ...Array.from({ length: 40 }, (_, i) => ({ remoteJid: `9000000000${String(i).padStart(4, "0")}@lid`, pushName: null })),
      { remoteJid: "0@s.whatsapp.net", pushName: "WhatsApp" },
      { remoteJid: "status@broadcast" },
    ];
    const { provider } = setup(() => json(items));
    const out = await provider.listContacts(channel);
    const by = (kind: string) => out.filter((c) => c.kind === kind).length;
    expect(out).toHaveLength(3092);
    expect([by("person"), by("group"), by("hidden"), by("other")]).toEqual([3000, 50, 40, 2]);
  });

  it("traduz falhas em ProviderError sem vazar a chave", async () => {
    for (const [status, code] of [
      [401, "invalid_credentials"],
      [403, "invalid_credentials"],
      [404, "invalid_credentials"],
      [400, "rejected"],
      [429, "unavailable"],
      [500, "unavailable"],
    ] as const) {
      const { provider } = setup(() => json({ error: "x" }, status));
      const error = await provider.listContacts(channel).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe(code);
      expect(String((error as ProviderError).message)).not.toContain("INSTANCE-TOKEN-0001");
    }
    const down = new EvolutionProvider({ baseUrl: "http://evolution.test", apiKey: "k", fetch: async () => Promise.reject(new Error("ECONNREFUSED")) });
    await expect(down.listContacts(channel)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("resposta que não é uma lista (ou corpo ilegível) é indisponível", async () => {
    for (const reply of [() => json({ contacts: [] }), () => new Response("<html>", { status: 200 })]) {
      const { provider } = setup(reply);
      await expect(provider.listContacts(channel)).rejects.toMatchObject({ code: "unavailable" });
    }
  });

  it("canal sem instância e sem chaves não chama o provedor", async () => {
    const { provider, calls } = setup(() => json([]));
    await expect(provider.listContacts({ ...channel, credentials: {} })).rejects.toMatchObject({ code: "not_configured" });
    expect(calls).toHaveLength(0);
  });
});
