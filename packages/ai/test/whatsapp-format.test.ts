import { describe, expect, it } from "vitest";
import { toWhatsappFormat } from "../src/agents/text";

describe("formatação para WhatsApp", () => {
  it.each([
    ["Seu agendamento de **jogar** está **confirmado**.", "Seu agendamento de *jogar* está *confirmado*."],
    ["para **sexta-feira, 30/10, às 08:00**.", "para *sexta-feira, 30/10, às 08:00*."],
    ["__importante__", "*importante*"],
    ["# Horários livres\nsexta às 08:00", "*Horários livres*\nsexta às 08:00"],
    ["* 08:00\n* 09:00", "- 08:00\n- 09:00"],
    ["Veja [nosso site](https://exemplo.com.br)", "Veja nosso site: https://exemplo.com.br"],
    ["use `pnpm dev`", "use pnpm dev"],
  ])("%s", (entrada, saida) => {
    expect(toWhatsappFormat(entrada)).toBe(saida);
  });

  it("não mexe no que já está certo (um asterisco, lista com hífen, texto comum, assinatura)", () => {
    for (const ok of ["Pronto! *confirmado* para sexta.", "- 08:00\n- 09:00", "Oi, tudo bem? 😊", "*Rafael (Vendas):*\nOlá"]) expect(toWhatsappFormat(ok)).toBe(ok);
  });

  it("multiplicação e asteriscos soltos no meio da frase ficam como estão", () => {
    expect(toWhatsappFormat("2 * 3 = 6")).toBe("2 * 3 = 6");
  });
});
