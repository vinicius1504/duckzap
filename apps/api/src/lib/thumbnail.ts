/** Maior lado da miniatura (px): cabe no balão (max-w-80) com folga para telas de alta densidade. */
export const THUMBNAIL_SIZE = 480;

/** Imagem maior que isso (pixels) não é decodificada: protege a memória de uma "bomba de descompressão". */
const MAX_INPUT_PIXELS = 64_000_000;

/** Chave da miniatura de um arquivo: mesmo prefixo da original (apagar por prefixo da empresa leva as duas). */
export const thumbnailKeyFor = (storageKey: string) => `${storageKey}-t`;

/**
 * Miniatura leve (WebP, lado maior de 480 px, na orientação certa) de uma imagem. Melhor esforço: devolve null se a imagem
 * não pôde ser lida; quem chama segue sem miniatura e o balão usa a original. O `sharp` é importado só aqui, na hora de
 * usar: se o binário nativo faltar no ambiente, só as miniaturas falham, nunca a rota.
 */
export async function makeThumbnail(bytes: Buffer): Promise<Buffer | null> {
  try {
    const { default: sharp } = await import("sharp");
    return await sharp(bytes, { failOn: "none", limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer();
  } catch {
    return null;
  }
}
