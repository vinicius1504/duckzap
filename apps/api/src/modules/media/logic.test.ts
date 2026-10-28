import { MEDIA_RULES, MEDIA_KINDS } from "@duckzap/contracts/media";
import { describe, expect, it } from "vitest";
import { FILE_TYPES, checkUpload, extensionOf, hasSignature, resolveInboundType, sanitizeFileName, storageKeyFor, type Signature } from "./logic";

const bytes = (...values: (number | string)[]) => Buffer.concat(values.map((v) => (typeof v === "number" ? Buffer.from([v]) : Buffer.from(v, "latin1"))));
const pad = (b: Buffer, n = 64) => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length), 0x41)]);

const SAMPLES: Record<Exclude<Signature, "text">, Buffer> = {
  jpeg: pad(bytes(0xff, 0xd8, 0xff, 0xe0)),
  png: pad(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a)),
  webp: pad(bytes("RIFF", 0x24, 0x00, 0x00, 0x00, "WEBPVP8 ")),
  pdf: pad(bytes("%PDF-1.7\n")),
  zip: pad(bytes("PK", 0x03, 0x04, 0x14, 0x00)),
  ole: pad(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)),
  ogg: pad(bytes("OggS", 0x00, 0x02)),
  mp3: pad(bytes(0xff, 0xfb, 0x90, 0x00)),
  mp4: pad(bytes(0x00, 0x00, 0x00, 0x20, "ftypM4A ")),
  webm: pad(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f)),
};
const SIGS = Object.keys(SAMPLES) as Exclude<Signature, "text">[];

describe("sanitizeFileName", () => {
  it("fica só com o último trecho do caminho", () => {
    expect(sanitizeFileName("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(sanitizeFileName("C:\\Users\\Ana\\relatório final.pdf")).toBe("relatório final.pdf");
    expect(sanitizeFileName("a/b/c.png")).toBe("c.png");
  });

  it("remove controle, NUL, quebra de linha e marcas de direção (gpj.exe invertido)", () => {
    expect(sanitizeFileName("foto\u0000.png")).toBe("foto.png");
    expect(sanitizeFileName("a\r\nb.pdf")).toBe("ab.pdf");
    expect(sanitizeFileName("recibo\u202Efdp.exe")).toBe("recibofdp.exe");
    expect(sanitizeFileName("\u200b\ufeffnota.pdf")).toBe("nota.pdf");
  });

  it("troca caracteres de caminho/URL, tira pontos e espaços das pontas", () => {
    expect(sanitizeFileName('  a<b>"c|d?e*.pdf  ')).toBe("a_b__c_d_e_.pdf");
    expect(sanitizeFileName("...oculto.pdf")).toBe("oculto.pdf");
    expect(sanitizeFileName("nome.pdf. . ")).toBe("nome.pdf");
    expect(sanitizeFileName("a    b.pdf")).toBe("a b.pdf");
  });

  it("limita a 200 caracteres preservando a extensão", () => {
    const out = sanitizeFileName(`${"x".repeat(500)}.pdf`);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("nome vazio depois de limpar continua vazio", () => {
    expect(sanitizeFileName("///")).toBe("");
    expect(sanitizeFileName("\u0000\u0001")).toBe("");
  });
});

describe("extensionOf", () => {
  it("minúscula, com ponto; sem extensão = vazio", () => {
    expect(extensionOf("Foto.JPG")).toBe(".jpg");
    expect(extensionOf("semextensao")).toBe("");
    expect(extensionOf(".pdf")).toBe("");
    expect(extensionOf("termina.")).toBe("");
    expect(extensionOf("a.tar.gz")).toBe(".gz");
  });
});

describe("storageKeyFor", () => {
  it("org/<empresa>/<ano-mes>/<uuid>, sem o nome do arquivo", () => {
    const key = storageKeyFor("org_abc", new Date("2026-03-09T12:00:00Z"));
    expect(key).toMatch(/^org\/org_abc\/2026-03\/[0-9a-f-]{36}$/);
    expect(storageKeyFor("org_abc", new Date("2026-03-09T12:00:00Z"))).not.toBe(key);
    expect(storageKeyFor("o", new Date("2026-12-31T23:59:59Z"), "fixo")).toBe("org/o/2026-12/fixo");
  });
});

describe("FILE_TYPES x MEDIA_RULES", () => {
  it("toda extensão e todo tipo do contrato têm regra (e a coerência é recíproca)", () => {
    for (const kind of MEDIA_KINDS) {
      const rules = MEDIA_RULES[kind];
      const mimes = new Set<string>();
      for (const ext of rules.extensions) {
        const type = FILE_TYPES[ext];
        expect(type, `extensão ${ext}`).toBeDefined();
        expect(type?.kind).toBe(kind);
        expect(rules.mimes as readonly string[]).toContain(type?.mime);
        mimes.add(type?.mime ?? "");
      }
      for (const mime of rules.mimes) expect(mimes.has(mime), `tipo ${mime} sem extensão`).toBe(true);
    }
  });
});

describe("checkUpload", () => {
  const ok = { kind: "document" as const, fileName: "Contrato.PDF", mimeType: "application/pdf", sizeBytes: 1000 };

  it("aceita e devolve nome sanitizado e tipo canônico", () => {
    const r = checkUpload({ ...ok, fileName: "pasta/Contrato.PDF" });
    expect(r).toMatchObject({ ok: true, fileName: "Contrato.PDF", ext: ".pdf" });
    if (r.ok) expect(r.type.mime).toBe("application/pdf");
  });

  it("recusa extensão fora da lista do tipo de mídia (.exe, .svg, .html, .pdf como imagem)", () => {
    expect(checkUpload({ ...ok, fileName: "setup.exe" }).ok).toBe(false);
    expect(checkUpload({ ...ok, fileName: "arquivo.pdf.exe" }).ok).toBe(false);
    expect(checkUpload({ kind: "image", fileName: "x.svg", mimeType: "image/svg+xml", sizeBytes: 10 }).ok).toBe(false);
    expect(checkUpload({ kind: "image", fileName: "doc.pdf", mimeType: "application/pdf", sizeBytes: 10 }).ok).toBe(false);
    expect(checkUpload({ ...ok, fileName: "semextensao" }).ok).toBe(false);
  });

  it("recusa tipo declarado que não está na lista ou não bate com a extensão", () => {
    expect(checkUpload({ ...ok, mimeType: "application/x-msdownload" }).ok).toBe(false);
    expect(checkUpload({ ...ok, mimeType: "image/png" }).ok).toBe(false);
    expect(checkUpload({ ...ok, fileName: "x.docx", mimeType: "application/pdf" }).ok).toBe(false);
    expect(checkUpload({ kind: "image", fileName: "a.png", mimeType: "image/jpeg", sizeBytes: 10 }).ok).toBe(false);
  });

  it("ignora parâmetros e caixa do tipo (audio/webm;codecs=opus)", () => {
    expect(checkUpload({ kind: "audio", fileName: "gravacao.webm", mimeType: "Audio/WebM;codecs=opus", sizeBytes: 5000 }).ok).toBe(true);
  });

  it("aceita .csv declarado como application/vnd.ms-excel (Windows), guardando text/csv", () => {
    const r = checkUpload({ ...ok, fileName: "lista.csv", mimeType: "application/vnd.ms-excel" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.type.mime).toBe("text/csv");
    // mas .xls continua xls
    const xls = checkUpload({ ...ok, fileName: "p.xls", mimeType: "application/vnd.ms-excel" });
    expect(xls.ok && xls.type.mime).toBe("application/vnd.ms-excel");
  });

  it("respeita o tamanho máximo de cada tipo e recusa arquivo vazio", () => {
    const mb = 1024 * 1024;
    expect(checkUpload({ kind: "image", fileName: "a.png", mimeType: "image/png", sizeBytes: 10 * mb }).ok).toBe(true);
    expect(checkUpload({ kind: "image", fileName: "a.png", mimeType: "image/png", sizeBytes: 10 * mb + 1 }).ok).toBe(false);
    expect(checkUpload({ ...ok, sizeBytes: 20 * mb }).ok).toBe(true);
    expect(checkUpload({ ...ok, sizeBytes: 20 * mb + 1 }).ok).toBe(false);
    expect(checkUpload({ kind: "audio", fileName: "a.mp3", mimeType: "audio/mpeg", sizeBytes: 16 * mb + 1 }).ok).toBe(false);
    expect(checkUpload({ ...ok, sizeBytes: 0 }).ok).toBe(false);
  });
});

describe("hasSignature — tipo real pelos primeiros bytes", () => {
  it.each(SIGS)("%s: aceita a assinatura certa", (sig) => {
    expect(hasSignature(sig, SAMPLES[sig])).toBe(true);
  });

  it.each(SIGS)("%s: recusa as outras assinaturas, vazio e executável", (sig) => {
    for (const [other, sample] of Object.entries(SAMPLES)) {
      if (other === sig) continue;
      expect(hasSignature(sig, sample), `${sig} aceitou ${other}`).toBe(false);
    }
    expect(hasSignature(sig, Buffer.alloc(0))).toBe(false);
    expect(hasSignature(sig, Buffer.from("MZ\u0090\u0000\u0003\u0000\u0000\u0000", "latin1"))).toBe(false);
  });

  it("arquivo .pdf com conteúdo de executável (MZ) é recusado", () => {
    const exe = Buffer.concat([Buffer.from("MZ", "latin1"), Buffer.alloc(200, 0)]);
    expect(hasSignature("pdf", exe)).toBe(false);
    expect(hasSignature("zip", exe)).toBe(false);
    expect(hasSignature("jpeg", exe)).toBe(false);
  });

  it("PNG exige a assinatura completa de 8 bytes; WebP exige RIFF....WEBP (WAV não passa)", () => {
    expect(hasSignature("png", bytes(0x89, "PNG"))).toBe(false);
    expect(hasSignature("webp", pad(bytes("RIFF", 0, 0, 0, 0, "WAVEfmt ")))).toBe(false);
  });

  it("MP3: ID3 ou quadro MPEG camada III; outros FFxx não", () => {
    expect(hasSignature("mp3", pad(bytes("ID3", 0x04)))).toBe(true);
    for (const b1 of [0xfb, 0xfa, 0xf3, 0xf2, 0xe3, 0xe2]) expect(hasSignature("mp3", pad(bytes(0xff, b1, 0x90))), `FF${b1.toString(16)}`).toBe(true);
    expect(hasSignature("mp3", pad(bytes(0xff, 0xf1, 0x50)))).toBe(false); // AAC ADTS
    expect(hasSignature("mp3", pad(bytes(0xff, 0x00)))).toBe(false);
  });

  it("MP4/M4A: 'ftyp' no deslocamento 4", () => {
    expect(hasSignature("mp4", pad(bytes(0, 0, 0, 0x18, "ftypisom")))).toBe(true);
    expect(hasSignature("mp4", pad(bytes("ftyp")))).toBe(false);
  });

  describe("texto (.txt/.csv)", () => {
    it("aceita texto comum, UTF-8 e Latin-1 com acentos, CSV e quebras de linha", () => {
      expect(hasSignature("text", Buffer.from("nome;valor\nJoão;10\r\nMaria;20\n", "utf8"))).toBe(true);
      expect(hasSignature("text", Buffer.from("ação não é coração\ttab", "latin1"))).toBe(true);
    });

    it("recusa NUL, vazio, excesso de controle e executáveis/zip/pdf/imagem renomeados", () => {
      expect(hasSignature("text", Buffer.alloc(0))).toBe(false);
      expect(hasSignature("text", Buffer.from("texto\u0000binário"))).toBe(false);
      expect(hasSignature("text", Buffer.from(Array.from({ length: 100 }, (_, i) => (i % 5 === 0 ? 0x01 : 0x41))))).toBe(false);
      expect(hasSignature("text", Buffer.from("MZ: parece texto mas é a assinatura de um exe", "latin1"))).toBe(false);
      expect(hasSignature("text", SAMPLES.zip)).toBe(false);
      expect(hasSignature("text", SAMPLES.pdf)).toBe(false);
      expect(hasSignature("text", SAMPLES.jpeg)).toBe(false);
      expect(hasSignature("text", SAMPLES.png)).toBe(false);
    });
  });
});

describe("resolveInboundType — mídia recebida", () => {
  it("imagem do WhatsApp (jpeg) mantém o nome com a extensão do tipo", () => {
    const r = resolveInboundType("image", "image/jpeg", "ABC123.jpeg");
    expect(r?.type.mime).toBe("image/jpeg");
    expect(r?.fileName).toBe("ABC123.jpeg");
  });

  it("nota de voz 'audio/ogg; codecs=opus' sem nome ganha nome e extensão", () => {
    const r = resolveInboundType("audio", "audio/ogg; codecs=opus", undefined);
    expect(r?.type.signature).toBe("ogg");
    expect(r?.fileName).toBe("audio.ogg");
  });

  it("documento com tipo genérico usa a extensão do nome; tipo fora da lista é recusado", () => {
    expect(resolveInboundType("document", "application/octet-stream", "Proposta.PDF")?.type.mime).toBe("application/pdf");
    expect(resolveInboundType("document", "application/octet-stream", "programa.exe")).toBeNull();
    expect(resolveInboundType("document", "application/zip", "pacote.zip")).toBeNull();
    expect(resolveInboundType("document", undefined, undefined)).toBeNull();
  });

  it("tipo declarado vence nome com extensão errada, e o nome é corrigido", () => {
    const r = resolveInboundType("image", "image/png", "foto.exe");
    expect(r?.type.mime).toBe("image/png");
    expect(r?.fileName).toBe("foto.png");
  });

  it("não deixa uma mídia virar outro tipo de mídia (pdf como imagem)", () => {
    expect(resolveInboundType("image", "application/pdf", "a.pdf")).toBeNull();
    expect(resolveInboundType("audio", "image/png", undefined)).toBeNull();
  });

  it("nome do cliente é sanitizado", () => {
    const r = resolveInboundType("document", "application/pdf", "../../x\u202E.pdf");
    expect(r?.fileName).toBe("x.pdf");
  });
});
