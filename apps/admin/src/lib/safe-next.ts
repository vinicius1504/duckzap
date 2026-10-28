const BASE = new URL("http://safe-next.invalid");

/**
 * Destino depois do login. Só aceita caminho interno (evita redirecionamento aberto).
 * Remove caracteres de controle e espaços (o navegador ignora TAB/CR/LF dentro de URLs, então "/\t/evil.com" vira "//evil.com")
 * e confere que o resultado continua na mesma origem.
 */
export function safeNext(value: string | null | undefined, fallback = "/visao-geral") {
  if (!value) return fallback;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\s]/g, "");
  if (!cleaned.startsWith("/") || cleaned.startsWith("//") || cleaned.includes("\\")) return fallback;
  try {
    const url = new URL(cleaned, BASE);
    if (url.origin !== BASE.origin) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
