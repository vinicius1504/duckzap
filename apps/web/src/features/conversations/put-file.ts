/**
 * PUT do arquivo direto no armazenamento (URL assinada). Usa XHR para ter progresso real.
 * O resultado NUNCA carrega a URL: quem mostra erro usa `putFailureMessage(status)` (lib/media.ts).
 */
export type PutResult = { ok: true } | { ok: false; status: number | null; aborted: boolean };

export function putFile(
  url: string,
  headers: Record<string, string>,
  body: Blob,
  options: { onProgress: (percent: number) => void; signal: AbortSignal },
): Promise<PutResult> {
  return new Promise((resolve) => {
    if (options.signal.aborted) return resolve({ ok: false, status: null, aborted: true });
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });
    const finish = (result: PutResult) => {
      options.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    try {
      xhr.open("PUT", url);
      for (const [name, value] of Object.entries(headers)) {
        try {
          xhr.setRequestHeader(name, value);
        } catch {
          // cabeçalho que o navegador não deixa definir (ex.: Content-Length): ele mesmo preenche
        }
      }
    } catch {
      return finish({ ok: false, status: null, aborted: false });
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) options.onProgress((event.loaded / event.total) * 100);
    };
    xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? { ok: true } : { ok: false, status: xhr.status, aborted: false });
    xhr.onerror = () => finish({ ok: false, status: null, aborted: false });
    xhr.ontimeout = () => finish({ ok: false, status: null, aborted: false });
    xhr.onabort = () => finish({ ok: false, status: null, aborted: true });
    xhr.send(body);
  });
}
