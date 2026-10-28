import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

const FB = "FALLBACK";

describe("safeNext", () => {
  it.each([
    ["/\t/evil.com"],
    ["/\n/x"],
    ["/\r/x"],
    ["//x"],
    ["/\\x"],
    ["https://x"],
    ["javascript:alert(1)"],
    ["/ /evil.com"],
    ["/\u0000/evil.com"],
    ["x/y"],
    [""],
    [null],
    [undefined],
  ])("recusa %j", (input) => {
    expect(safeNext(input as string | null | undefined, FB)).toBe(FB);
  });

  it("aceita caminho interno com query e hash", () => {
    expect(safeNext("/clientes?aba=ativos#topo", FB)).toBe("/clientes?aba=ativos#topo");
    expect(safeNext("/conversas/123", FB)).toBe("/conversas/123");
  });
});
