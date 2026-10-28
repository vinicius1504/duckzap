import { describe, expect, it } from "vitest";
import { openConversationId, refreshRuleFor, shouldPoll } from "./routes";
import { stripUnreadPrefix, withUnreadPrefix } from "./title";

describe("refreshRuleFor", () => {
  it("cada tela reage aos seus avisos", () => {
    expect(refreshRuleFor("/conversas")?.types.has("conversation.message")).toBe(true);
    expect(refreshRuleFor("/conversas")?.types.has("message.status")).toBe(true);
    expect(refreshRuleFor("/conversas")?.types.has("home.invalidate")).toBe(false);
    expect(refreshRuleFor("/conversas")?.types.has("typing")).toBe(false);
    expect(refreshRuleFor("/inicio")?.types.has("home.invalidate")).toBe(true);
    expect(refreshRuleFor("/canais")?.types.has("channel.status")).toBe(true);
    expect(refreshRuleFor("/agenda")?.types.has("home.invalidate")).toBe(true);
  });
  it("outras telas (ajustes, clientes…) não atualizam sozinhas", () => {
    for (const p of ["/ajustes", "/clientes", "/", "/conversasX", null]) expect(refreshRuleFor(p)).toBeNull();
  });
  it("só Canais adia o refresh com diálogo aberto", () => {
    expect(refreshRuleFor("/canais")?.deferWhileDialogOpen).toBe(true);
    expect(refreshRuleFor("/conversas")?.deferWhileDialogOpen).toBe(false);
  });
  it("subrotas contam", () => {
    expect(refreshRuleFor("/canais/novo")?.base).toBe("/canais");
  });
});

describe("shouldPoll", () => {
  it("conversas, início e canais fazem polling offline; agenda não", () => {
    expect(shouldPoll("/conversas")).toBe(true);
    expect(shouldPoll("/inicio")).toBe(true);
    expect(shouldPoll("/canais")).toBe(true);
    expect(shouldPoll("/agenda")).toBe(false);
    expect(shouldPoll("/ajustes")).toBe(false);
  });
});

describe("openConversationId", () => {
  const params = (q: string) => new URLSearchParams(q);
  it("lê ?conversa= só em /conversas e fora do quadro", () => {
    expect(openConversationId("/conversas", params("conversa=c1"))).toBe("c1");
    expect(openConversationId("/conversas", params("conversa=c1&visao=quadro"))).toBeNull();
    expect(openConversationId("/conversas", params(""))).toBeNull();
    expect(openConversationId("/inicio", params("conversa=c1"))).toBeNull();
    expect(openConversationId(null, params("conversa=c1"))).toBeNull();
  });
});

describe("título da aba", () => {
  it("acrescenta e troca o contador sem empilhar", () => {
    expect(withUnreadPrefix("Conversas · DuckChat", 3)).toBe("(3) Conversas · DuckChat");
    expect(withUnreadPrefix("(3) Conversas · DuckChat", 4)).toBe("(4) Conversas · DuckChat");
    expect(withUnreadPrefix("(4) DuckChat", 0)).toBe("DuckChat");
    expect(withUnreadPrefix("DuckChat", 150)).toBe("(99+) DuckChat");
    expect(stripUnreadPrefix("(99+) DuckChat")).toBe("DuckChat");
  });
});
