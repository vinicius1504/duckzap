// Baixar imagem de um link que o PROVEDOR nos deu (foto de produto do catálogo, foto de perfil do contato). O link vem de fora,
// então nunca buscamos um endereço qualquer (anti-SSRF): só https, só hosts de mídia do WhatsApp/Meta, sem redirecionamento.

/** Baixa uma imagem remota. null = não deu (host não permitido, grande demais, falha de rede). Nunca lança. */
export type ImageFetcher = (url: string) => Promise<{ bytes: Buffer; contentType: string | undefined } | null>;

const IMAGE_TIMEOUT_MS = 10_000;
/** Teto padrão: foto de produto no catálogo do WhatsApp é pequena; acima disso não vale guardar. */
export const MAX_REMOTE_IMAGE_BYTES = 5 * 1024 * 1024;
/** Só os servidores de mídia do próprio WhatsApp/Meta (o link vem do provedor; nunca buscamos um endereço qualquer). */
const ALLOWED_IMAGE_HOSTS = [".whatsapp.net", ".whatsapp.com", ".fbcdn.net", ".cdninstagram.com"] as const;

export function isAllowedImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_IMAGE_HOSTS.some((suffix) => host.endsWith(suffix));
}

/** Fetcher padrão: só hosts do WhatsApp, sem seguir redirecionamento, com prazo e teto de tamanho (lido aos poucos). */
export function createImageFetcher(fetchImpl: typeof fetch = fetch, options: { maxBytes?: number } = {}): ImageFetcher {
  const maxBytes = options.maxBytes ?? MAX_REMOTE_IMAGE_BYTES;
  return async (url) => {
    if (!isAllowedImageUrl(url)) return null;
    try {
      const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
      if (!response.ok || !response.body) return null;
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body.cancel().catch(() => {});
        return null;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += part.byteLength;
        if (total > maxBytes) return null;
        chunks.push(Buffer.from(part));
      }
      return { bytes: Buffer.concat(chunks), contentType: response.headers.get("content-type") ?? undefined };
    } catch {
      return null;
    }
  };
}
