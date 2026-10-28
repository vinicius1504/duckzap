import { describe, expect, it } from "vitest";
import {
  acceptAttribute,
  allowedTypesLabel,
  canCancelUpload,
  describeAttachment,
  describeFile,
  extensionOf,
  formatDuration,
  formatFileSize,
  INITIAL_UPLOAD_STATE,
  isUploadBusy,
  mediaPreviewLabel,
  mediaRulesHint,
  micErrorMessage,
  normalizeMime,
  pickRecorderMime,
  putFailureMessage,
  recordedFileName,
  uploadProgressValue,
  uploadReducer,
  uploadStatusText,
  validateMediaFile,
  type UploadEvent,
  type UploadState,
} from "./media";

const MB = 1024 * 1024;

describe("formatFileSize", () => {
  it("usa B/KB/MB com vírgula", () => {
    expect(formatFileSize(0)).toBe("0 KB");
    expect(formatFileSize(10)).toBe("1 KB");
    expect(formatFileSize(812 * 1024)).toBe("812 KB");
    expect(formatFileSize(2.4 * MB)).toBe("2,4 MB");
    expect(formatFileSize(10 * MB)).toBe("10 MB");
    expect(formatFileSize(1024 * MB * 1.5)).toBe("1,5 GB");
  });

  it("não mostra 1024 KB", () => {
    expect(formatFileSize(1024 * 1024 - 100)).toBe("1 MB");
  });
});

describe("formatDuration", () => {
  it("mostra m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(12)).toBe("0:12");
    expect(formatDuration(65.9)).toBe("1:05");
    expect(formatDuration(-3)).toBe("0:00");
    expect(formatDuration(Number.NaN)).toBe("0:00");
  });
});

describe("tipos aceitos (vêm de MEDIA_RULES)", () => {
  it("lista legível por categoria", () => {
    expect(allowedTypesLabel("image")).toBe("JPG, PNG ou WebP");
    expect(allowedTypesLabel("document")).toBe("PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT ou CSV");
    expect(mediaRulesHint("image")).toBe("JPG, PNG ou WebP até 10 MB");
    expect(mediaRulesHint("document")).toContain("até 20 MB");
    expect(mediaRulesHint("audio")).toContain("até 16 MB");
  });

  it("accept junta extensões e tipos", () => {
    const accept = acceptAttribute("image").split(",");
    expect(accept).toContain(".png");
    expect(accept).toContain("image/webp");
    expect(accept).not.toContain("image/gif");
  });

  it("extensionOf e normalizeMime", () => {
    expect(extensionOf("Foto.JPG")).toBe(".jpg");
    expect(extensionOf("sem-extensao")).toBe("");
    expect(extensionOf("a.b.pdf")).toBe(".pdf");
    expect(normalizeMime("Audio/WebM; codecs=opus")).toBe("audio/webm");
  });
});

describe("validateMediaFile", () => {
  it("aceita imagem permitida e devolve o mime", () => {
    expect(validateMediaFile("image", { name: "a.png", type: "image/png", size: 2 * MB })).toEqual({ ok: true, mimeType: "image/png" });
  });

  it("recusa tipo fora da lista com a mensagem clara", () => {
    const r = validateMediaFile("image", { name: "a.gif", type: "image/gif", size: 1000 });
    expect(r).toEqual({
      ok: false,
      reason: "type",
      message: "Esse tipo de arquivo não pode ser enviado. Use JPG, PNG ou WebP até 10 MB.",
    });
  });

  it("recusa arquivo grande demais citando o tamanho e o limite", () => {
    const r = validateMediaFile("image", { name: "a.jpg", type: "image/jpeg", size: 12.5 * MB });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("size");
      expect(r.message).toContain("12,5 MB");
      expect(r.message).toContain("10 MB");
    }
  });

  it("o limite exato passa e 1 byte acima não", () => {
    expect(validateMediaFile("image", { name: "a.jpg", type: "image/jpeg", size: 10 * MB }).ok).toBe(true);
    expect(validateMediaFile("image", { name: "a.jpg", type: "image/jpeg", size: 10 * MB + 1 }).ok).toBe(false);
    expect(validateMediaFile("document", { name: "a.pdf", type: "application/pdf", size: 20 * MB + 1 }).ok).toBe(false);
    expect(validateMediaFile("audio", { name: "a.webm", type: "audio/webm", size: 16 * MB + 1 }).ok).toBe(false);
  });

  it("recusa arquivo vazio", () => {
    const r = validateMediaFile("document", { name: "a.pdf", type: "application/pdf", size: 0 });
    expect(r).toMatchObject({ ok: false, reason: "empty" });
  });

  it("sem tipo do navegador usa a extensão", () => {
    expect(validateMediaFile("document", { name: "Contrato.DOCX", type: "", size: 100 })).toEqual({
      ok: true,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(validateMediaFile("document", { name: "x.pdf", type: "application/octet-stream", size: 100 })).toMatchObject({
      ok: true,
      mimeType: "application/pdf",
    });
    expect(validateMediaFile("document", { name: "x.exe", type: "", size: 100 })).toMatchObject({ ok: false, reason: "type" });
    expect(validateMediaFile("document", { name: "semextensao", type: "", size: 100 })).toMatchObject({ ok: false, reason: "type" });
  });

  it("não deixa executável passar com tipo de documento falso", () => {
    expect(validateMediaFile("document", { name: "a.exe", type: "application/x-msdownload", size: 100 })).toMatchObject({
      ok: false,
      reason: "type",
    });
    expect(validateMediaFile("image", { name: "a.pdf", type: "application/pdf", size: 100 })).toMatchObject({ ok: false, reason: "type" });
  });

  it(".csv marcado como planilha pelo navegador vai como text/csv", () => {
    expect(validateMediaFile("document", { name: "lista.csv", type: "application/vnd.ms-excel", size: 100 })).toEqual({
      ok: true,
      mimeType: "text/csv",
    });
  });

  it("áudio gravado: ignora os parâmetros do tipo", () => {
    expect(validateMediaFile("audio", { name: "audio.webm", type: "audio/webm;codecs=opus", size: 5000 })).toEqual({
      ok: true,
      mimeType: "audio/webm",
    });
  });
});

describe("rótulos por tipo", () => {
  it("documentos", () => {
    expect(describeFile("application/pdf", "a.pdf")).toEqual({ label: "PDF", short: "PDF" });
    expect(describeFile("application/vnd.openxmlformats-officedocument.wordprocessingml.document", null).label).toBe("Word");
    expect(describeFile("application/vnd.ms-excel", "a.xls")).toEqual({ label: "Planilha", short: "XLS" });
    expect(describeFile("application/vnd.ms-excel", "a.csv").label).toBe("CSV");
    expect(describeFile("application/vnd.openxmlformats-officedocument.presentationml.presentation", null).short).toBe("PPT");
    expect(describeFile("text/plain", null).label).toBe("Texto");
  });

  it("imagem, áudio e desconhecido", () => {
    expect(describeFile("image/png", null).label).toBe("Imagem");
    expect(describeFile("audio/webm;codecs=opus", null).label).toBe("Áudio");
    expect(describeFile("application/zip", "pacote.zip")).toEqual({ label: "ZIP", short: "ZIP" });
    expect(describeFile("application/x", null)).toEqual({ label: "Arquivo", short: "ARQ" });
  });

  it("describeAttachment junta tipo, duração e tamanho", () => {
    expect(describeAttachment({ mimeType: "application/pdf", fileName: "a.pdf", sizeBytes: 2.4 * MB })).toBe("PDF · 2,4 MB");
    expect(describeAttachment({ mimeType: "audio/webm", fileName: null, sizeBytes: null, durationSeconds: 12 })).toBe("Áudio · 0:12");
  });
});

describe("mediaPreviewLabel", () => {
  it("imagem, documento e áudio", () => {
    expect(mediaPreviewLabel({ kind: "image", fileName: null, durationSeconds: null })).toBe("📷 Imagem");
    expect(mediaPreviewLabel({ kind: "image", fileName: null, durationSeconds: null, caption: "Olha isso" })).toBe("📷 Olha isso");
    expect(mediaPreviewLabel({ kind: "document", fileName: "orcamento.pdf", durationSeconds: null })).toBe("📄 orcamento.pdf");
    expect(mediaPreviewLabel({ kind: "document", fileName: null, durationSeconds: null })).toBe("📄 Documento");
    expect(mediaPreviewLabel({ kind: "audio", fileName: null, durationSeconds: 12 })).toBe("🎤 Áudio 0:12");
    expect(mediaPreviewLabel({ kind: "audio", fileName: null, durationSeconds: null })).toBe("🎤 Áudio");
  });
});

describe("gravação", () => {
  it("escolhe o primeiro formato suportado", () => {
    expect(pickRecorderMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMime((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecorderMime(() => false)).toBeNull();
  });

  it("nome do arquivo gravado", () => {
    const at = new Date("2026-10-28T15:30:12.000Z");
    expect(recordedFileName("audio/webm;codecs=opus", at)).toBe("audio-20261028-153012.webm");
    expect(recordedFileName("audio/mp4", at)).toBe("audio-20261028-153012.m4a");
    expect(recordedFileName("audio/ogg", at)).toBe("audio-20261028-153012.ogg");
  });

  it("mensagem por motivo de falha do microfone", () => {
    expect(micErrorMessage("NotAllowedError")).toContain("bloqueou o microfone");
    expect(micErrorMessage("NotFoundError")).toContain("Não encontramos um microfone");
    expect(micErrorMessage("NotReadableError")).toContain("em uso");
    expect(micErrorMessage("unsupported")).toContain("não permite gravar");
    expect(micErrorMessage("Qualquer")).toContain("Não deu para iniciar");
  });
});

describe("uploadReducer", () => {
  const run = (events: UploadEvent[], from: UploadState = INITIAL_UPLOAD_STATE) => events.reduce(uploadReducer, from);

  it("caminho feliz: escolhido → enviando(n%) → conferindo → enviando mensagem → enviado", () => {
    expect(run([{ type: "pick" }])).toEqual({ phase: "chosen" });
    expect(run([{ type: "pick" }, { type: "start" }])).toEqual({ phase: "uploading", percent: 0 });
    expect(run([{ type: "pick" }, { type: "start" }, { type: "progress", percent: 42.4 }])).toEqual({ phase: "uploading", percent: 42 });
    const checking = run([{ type: "pick" }, { type: "start" }, { type: "progress", percent: 100 }, { type: "uploaded" }]);
    expect(checking).toEqual({ phase: "checking" });
    expect(run([{ type: "checked" }], checking)).toEqual({ phase: "sending" });
    expect(run([{ type: "checked" }, { type: "sent" }], checking)).toEqual({ phase: "sent" });
  });

  it("progresso nunca anda para trás e fica entre 0 e 100", () => {
    const s = run([{ type: "pick" }, { type: "start" }, { type: "progress", percent: 60 }, { type: "progress", percent: 30 }]);
    expect(s).toEqual({ phase: "uploading", percent: 60 });
    expect(run([{ type: "progress", percent: 180 }], s)).toEqual({ phase: "uploading", percent: 100 });
    expect(run([{ type: "progress", percent: -5 }], s)).toBe(s);
  });

  it("transição inválida devolve o mesmo estado", () => {
    const idle = INITIAL_UPLOAD_STATE;
    expect(uploadReducer(idle, { type: "start" })).toBe(idle);
    expect(uploadReducer(idle, { type: "progress", percent: 10 })).toBe(idle);
    expect(uploadReducer(idle, { type: "uploaded" })).toBe(idle);
    expect(uploadReducer(idle, { type: "fail", step: "upload", message: "x" })).toBe(idle);
    const busy: UploadState = { phase: "uploading", percent: 5 };
    expect(uploadReducer(busy, { type: "pick" })).toBe(busy);
    expect(uploadReducer(busy, { type: "start" })).toBe(busy);
  });

  it("erro guarda a etapa e a mensagem; tentar de novo recomeça do envio", () => {
    const failed = run([{ type: "pick" }, { type: "start" }, { type: "fail", step: "upload", message: "Rede caiu" }]);
    expect(failed).toEqual({ phase: "error", step: "upload", message: "Rede caiu" });
    expect(run([{ type: "retry" }], failed)).toEqual({ phase: "uploading", percent: 0 });
  });

  it("falha só ao enviar a mensagem reaproveita o arquivo (volta direto a 'enviando mensagem')", () => {
    const failed: UploadState = { phase: "error", step: "send", message: "Sem canal" };
    expect(uploadReducer(failed, { type: "retry" })).toEqual({ phase: "sending" });
  });

  it("depois de um erro dá para escolher outro arquivo; reset limpa tudo", () => {
    const failed: UploadState = { phase: "error", step: "check", message: "x" };
    expect(uploadReducer(failed, { type: "pick" })).toEqual({ phase: "chosen" });
    expect(uploadReducer(failed, { type: "reset" })).toEqual({ phase: "idle" });
    expect(uploadReducer({ phase: "uploading", percent: 50 }, { type: "reset" })).toEqual({ phase: "idle" });
  });

  it("busy / cancelar / textos", () => {
    expect(isUploadBusy({ phase: "uploading", percent: 1 })).toBe(true);
    expect(isUploadBusy({ phase: "checking" })).toBe(true);
    expect(isUploadBusy({ phase: "sending" })).toBe(true);
    expect(isUploadBusy({ phase: "chosen" })).toBe(false);
    expect(isUploadBusy({ phase: "error", step: "upload", message: "x" })).toBe(false);

    expect(canCancelUpload({ phase: "uploading", percent: 1 })).toBe(true);
    expect(canCancelUpload({ phase: "chosen" })).toBe(true);
    expect(canCancelUpload({ phase: "error", step: "upload", message: "x" })).toBe(true);
    expect(canCancelUpload({ phase: "checking" })).toBe(false);
    expect(canCancelUpload({ phase: "sending" })).toBe(false);

    expect(uploadStatusText({ phase: "uploading", percent: 0 })).toBe("Preparando o envio…");
    expect(uploadStatusText({ phase: "uploading", percent: 42 })).toBe("Enviando o arquivo… 42%");
    expect(uploadStatusText({ phase: "checking" })).toBe("Conferindo o arquivo…");
    expect(uploadStatusText({ phase: "error", step: "check", message: "Arquivo inválido." })).toBe("Arquivo inválido.");
    expect(uploadProgressValue({ phase: "uploading", percent: 42 })).toBe(42);
    expect(uploadProgressValue({ phase: "checking" })).toBe(100);
    expect(uploadProgressValue({ phase: "chosen" })).toBe(0);
  });
});

describe("putFailureMessage", () => {
  it("rede/CORS e erros HTTP viram texto fixo, sem URL", () => {
    expect(putFailureMessage(null)).toBe("Não foi possível enviar o arquivo. Tente de novo.");
    expect(putFailureMessage(500)).toBe("Não foi possível enviar o arquivo. Tente de novo.");
    expect(putFailureMessage(403)).toContain("tempo para enviar");
    for (const status of [null, 400, 403, 500]) expect(putFailureMessage(status)).not.toMatch(/https?:|X-Amz/i);
  });
});
