import { describe, expect, it } from "vitest";
import { formatLocal, formatNow, hasRealName, localDate } from "../src/agents/local-time";

describe("horário local para o cliente", () => {
  it("converte UTC para o fuso da empresa, com dia da semana", () => {
    expect(formatLocal("2026-10-30T17:00:00Z", "America/Sao_Paulo")).toBe("sexta-feira, 30/10 às 14:00");
    expect(formatLocal("2026-10-30T17:00:00Z", "America/Campo_Grande")).toBe("sexta-feira, 30/10 às 13:00");
  });
  it("vira o dia quando o fuso empurra a hora para trás ou para frente", () => {
    expect(formatLocal("2026-11-01T02:30:00Z", "America/Sao_Paulo")).toBe("sábado, 31/10 às 23:30");
  });
  it("hoje, no formato que a ferramenta de agenda pede", () => {
    const now = new Date("2026-10-28T13:00:00Z");
    expect(localDate(now, "America/Sao_Paulo")).toBe("2026-10-28");
    expect(localDate(new Date("2026-10-29T01:30:00Z"), "America/Sao_Paulo")).toBe("2026-10-28");
    expect(formatNow(now, "America/Sao_Paulo")).toBe("quarta-feira, 28/10/2026, 10:00 (fuso America/Sao_Paulo; hoje é 2026-10-28)");
  });
  it("fuso inválido ou ausente cai no de São Paulo; instante inválido volta como veio", () => {
    expect(formatLocal("2026-10-30T17:00:00Z", "Mars/Olympus")).toBe("sexta-feira, 30/10 às 14:00");
    expect(formatLocal("2026-10-30T17:00:00Z")).toBe("sexta-feira, 30/10 às 14:00");
    expect(formatLocal("não é data", "America/Sao_Paulo")).toBe("não é data");
  });
});

describe("o cadastro tem um nome de verdade?", () => {
  it.each([
    ["Maria Souza", true],
    ["Jo", true],
    ["+55 67 99999-0000", false],
    ["67999990000", false],
    ["Sem nome", false],
    ["(sem nome)", false],
    ["", false],
    [null, false],
    ["A", false],
  ])("%s → %s", (name, expected) => {
    expect(hasRealName(name)).toBe(expected);
  });
});
