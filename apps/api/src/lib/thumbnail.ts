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

/** Lado (px) da foto de perfil guardada: o maior avatar da tela tem 56 px; 192 cobre telas 3x. */
export const AVATAR_SIZE = 192;

/**
 * Foto de perfil pronta para guardar: quadrada (recorte central), WebP pequeno, na orientação certa e SEM metadados (EXIF pode
 * trazer localização). Ao contrário de `makeThumbnail` ela é a ÚNICA cópia guardada, então aqui imagem ilegível = null e quem
 * chama recusa a foto (é assim que o "tipo real" é conferido: só o que o decodificador abre passa).
 */
export async function makeAvatar(bytes: Buffer): Promise<Buffer | null> {
  try {
    const { default: sharp } = await import("sharp");
    return await sharp(bytes, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, fit: "cover", position: "centre" })
      .flatten({ background: "#ffffff" })
      .webp({ quality: 75 })
      .toBuffer();
  } catch {
    return null;
  }
}
