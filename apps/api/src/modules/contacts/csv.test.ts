import { describe, expect, it } from "vitest";
import { buildCsv, buildImportSheet, cleanEmail, csvCell, detectDelimiter, parseBirthDate, parseCsv, suggestField } from "./csv";
import { normalizePhone } from "./phone";

describe("exportação CSV", () => {
  it("neutraliza injeção de fórmula: = + - @ ganham aspa simples", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell("+5567998123456")).toBe("'+5567998123456");
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("\t=1")).toBe("'\t=1");
  });

  it("não altera texto comum e cita quando há ; aspas ou quebra de linha", () => {
    expect(csvCell("Maria Silva")).toBe("Maria Silva");
    expect(csvCell("Silva; Maria")).toBe('"Silva; Maria"');
    expect(csvCell('Ele disse "oi"')).toBe('"Ele disse ""oi"""');
    expect(csvCell("linha1\nlinha2")).toBe('"linha1\nlinha2"');
  });

  it("usa ; como separador e começa com BOM (Excel pt-BR)", () => {
    const csv = buildCsv(["Nome", "Telefone"], [["Ana", "+5567999990000"], ["=cmd", "x"]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.slice(1).split("\r\n")).toEqual(["Nome;Telefone", "Ana;'+5567999990000", "'=cmd;x"]);
  });
});

describe("importação: leitura do CSV", () => {
  it("detecta ; , e tab pelo cabeçalho", () => {
    expect(detectDelimiter("nome;telefone\na;b")).toBe(";");
    expect(detectDelimiter("nome,telefone\na,b")).toBe(",");
    expect(detectDelimiter("nome\ttelefone\na\tb")).toBe("\t");
    expect(detectDelimiter('"a;b",c\n')).toBe(",");
  });

  it("lê aspas, aspas escapadas, vírgula dentro de campo, CRLF e BOM", () => {
    const rows = parseCsv('﻿nome,obs\r\n"Silva, Ana","disse ""oi"""\r\n\r\nBia,\r\n');
    expect(rows).toEqual([
      ["nome", "obs"],
      ["Silva, Ana", 'disse "oi"'],
      ["Bia", ""],
    ]);
  });

  it("monta colunas com sugestão de mapeamento e linhas por chave", () => {
    const sheet = buildImportSheet("Nome completo;Celular;E-mail;Nascimento;Observação\nMarta;(67) 99130-4455;marta@x.com;12/04/1983;quer orçamento\n");
    expect(sheet.columns.map((c) => c.suggested)).toEqual(["name", "phone", "email", "birthDate", "note"]);
    expect(sheet.rows).toEqual([{ c1: "Marta", c2: "(67) 99130-4455", c3: "marta@x.com", c4: "12/04/1983", c5: "quer orçamento" }]);
  });

  it("só sugere cada campo uma vez", () => {
    const sheet = buildImportSheet("Nome;Nome do responsável;Telefone\nA;B;1");
    expect(sheet.columns.map((c) => c.suggested)).toEqual(["name", "ignore", "phone"]);
  });

  it("suggestField reconhece variações comuns", () => {
    expect(suggestField("WhatsApp")).toBe("phone");
    expect(suggestField("e-mail")).toBe("email");
    expect(suggestField("Data de nascimento")).toBe("birthDate");
    expect(suggestField("Cidade")).toBe("ignore");
  });

  it("datas: aceita AAAA-MM-DD e DD/MM/AAAA, rejeita impossíveis e futuras", () => {
    expect(parseBirthDate("1983-04-12")).toBe("1983-04-12");
    expect(parseBirthDate("12/04/1983")).toBe("1983-04-12");
    expect(parseBirthDate("31/02/1990")).toBeNull();
    expect(parseBirthDate("2999-01-01")).toBeNull();
    expect(parseBirthDate("ontem")).toBeNull();
    expect(parseBirthDate("")).toBeNull();
  });

  it("e-mail inválido vira null", () => {
    expect(cleanEmail(" Ana@Email.com ")).toBe("ana@email.com");
    expect(cleanEmail("sem-arroba")).toBeNull();
  });
});

describe("normalizePhone (E.164)", () => {
  it.each([
    ["(67) 99812-3456", "+5567998123456"],
    ["67 98877-6611", "+5567988776611"],
    ["+55 67 99222-1100", "+5567992221100"],
    ["5567991230000", "+5567991230000"],
    ["(11) 3333-4444", "+551133334444"],
  ])("%s → %s", (raw, phone) => expect(normalizePhone(raw)).toEqual({ ok: true, phone }));

  it("vazio é no_phone e comprimento errado é invalid_phone", () => {
    expect(normalizePhone("")).toEqual({ ok: false, reason: "no_phone" });
    expect(normalizePhone("sem telefone")).toEqual({ ok: false, reason: "no_phone" });
    expect(normalizePhone("12345")).toEqual({ ok: false, reason: "invalid_phone" });
    expect(normalizePhone("1234567890123456")).toEqual({ ok: false, reason: "invalid_phone" });
  });
});
