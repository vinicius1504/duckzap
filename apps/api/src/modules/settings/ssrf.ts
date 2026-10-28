import { lookup as dnsLookup } from "node:dns";
import { promises as dns } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";

/**
 * Proteção contra SSRF nos webhooks de saída (§5.2): o servidor nunca chama endereço interno.
 * Bloqueia loopback, redes privadas, link-local (inclui o metadata da nuvem 169.254.169.254),
 * CGNAT, multicast e reservados, em IPv4 e IPv6, e valida o IP de verdade no momento de conectar
 * (função `lookup` do socket), o que fecha a brecha de DNS rebinding. Redirecionamentos são
 * seguidos à mão e cada salto passa pela mesma checagem.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function isBlockedIPv4(ip: string): boolean {
  const parsed = parseIPv4(ip);
  if (!parsed) return true; // formato estranho: bloqueia
  const [a = 0, b = 0, c = 0] = parsed;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // privada
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // privada
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // documentação
  if (a === 192 && b === 168) return true; // privada
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 198 && b === 51 && c === 100) return true; // documentação
  if (a === 203 && b === 0 && c === 113) return true; // documentação
  if (a >= 224) return true; // multicast, reservado, broadcast
  return false;
}

/** Expande um IPv6 para 8 grupos de 16 bits (aceita `::` e IPv4 embutido no fim). */
function expandIPv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const v4Tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail?.[1]) {
    const v4 = parseIPv4(v4Tail[1]);
    if (!v4) return null;
    const hi = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
    const lo = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
    text = text.slice(0, text.length - v4Tail[1].length) + hi.toString(16) + ":" + lo.toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...(halves.length === 2 ? Array<string>(missing).fill("0") : []), ...tail];
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : null;
}

function isBlockedIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g.every((x) => x === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
  const embeddedV4 = `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
  // ::ffff:a.b.c.d (IPv4 mapeado) e ::a.b.c.d (compatível): vale a regra do IPv4
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return isBlockedIPv4(embeddedV4);
  // 64:ff9b::/96 (NAT64): vale a regra do IPv4 embutido
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isBlockedIPv4(embeddedV4);
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 (site-local, obsoleto)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentação
  if (g0 === 0x2002) return isBlockedIPv4(`${g1 >> 8}.${g1 & 255}.${g2 >> 8}.${g2 & 255}`); // 6to4
  return false;
}

/** true se o endereço (texto) é interno/reservado e não pode ser chamado. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip.startsWith("[") ? ip.slice(1, -1) : ip);
  const clean = ip.startsWith("[") ? ip.slice(1, -1) : ip;
  if (kind === 4) return isBlockedIPv4(clean);
  if (kind === 6) return isBlockedIPv6(clean);
  return true;
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

/** Validação de forma (sem rede): esquema https, sem credenciais, host não interno. */
export function assertSafeUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("URL inválida.");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("Use uma URL com https://.");
  if (url.username || url.password) throw new UnsafeUrlError("A URL não pode ter usuário e senha.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new UnsafeUrlError("URL inválida.");
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError("Esse endereço é interno e não pode receber webhooks.");
  }
  const literal = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(literal) !== 0 && isBlockedIp(literal)) {
    throw new UnsafeUrlError("Esse endereço é interno e não pode receber webhooks.");
  }
  // formatos numéricos exóticos que o navegador entende (ex.: 2130706433, 0x7f.1): o WHATWG URL já normaliza
  // para a forma decimal pontuada, então caem na checagem acima; sobra bloquear host só com dígitos/pontos inválido.
  if (/^[\d.]+$/.test(literal) && isIP(literal) === 0) throw new UnsafeUrlError("URL inválida.");
  return url;
}

/** Validação completa: forma + resolução de DNS (todos os IPs devolvidos precisam ser públicos). */
export async function assertSafeUrl(raw: string, resolve: Resolver = systemResolver): Promise<URL> {
  const url = assertSafeUrlShape(raw);
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(host) !== 0) return url;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new UnsafeUrlError("Não conseguimos encontrar esse endereço.");
  }
  if (addresses.length === 0) throw new UnsafeUrlError("Não conseguimos encontrar esse endereço.");
  if (addresses.some(isBlockedIp)) throw new UnsafeUrlError("Esse endereço é interno e não pode receber webhooks.");
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/** `lookup` do socket: resolve e recusa se QUALQUER IP for interno (vale no instante da conexão). */
export function createSafeLookup(resolveAll = defaultLookupAll) {
  return (hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback) => {
    resolveAll(hostname)
      .then((records) => {
        if (records.length === 0 || records.some((r) => isBlockedIp(r.address))) {
          callback(Object.assign(new UnsafeUrlError("Endereço interno bloqueado."), { code: "EBLOCKED" }) as NodeJS.ErrnoException, "");
          return;
        }
        if (options.all) callback(null, records);
        else callback(null, records[0]?.address ?? "", records[0]?.family);
      })
      .catch((error: NodeJS.ErrnoException) => callback(error, ""));
  };
}

function defaultLookupAll(hostname: string) {
  return new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
}

export type SafePostResult = { statusCode: number; durationMs: number };

export type SafePostOptions = {
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
  maxRedirects?: number;
  resolve?: Resolver;
  /** Para teste: troca a conexão real. */
  transport?: typeof request;
};

/**
 * POST seguro: valida a URL (e cada redirecionamento), conecta só em IP público e limita tempo e tamanho.
 * Não devolve o corpo da resposta (evita usar o servidor para ler dados internos).
 */
export async function safePost(rawUrl: string, options: SafePostOptions): Promise<SafePostResult> {
  const started = Date.now();
  const maxRedirects = options.maxRedirects ?? 3;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertSafeUrl(current, options.resolve);
    const status = await postOnce(url, options);
    if (status.statusCode >= 300 && status.statusCode < 400 && status.location) {
      if (hop === maxRedirects) throw new UnsafeUrlError("Redirecionamentos demais.");
      current = new URL(status.location, url).toString();
      continue;
    }
    return { statusCode: status.statusCode, durationMs: Date.now() - started };
  }
  throw new UnsafeUrlError("Redirecionamentos demais.");
}

function postOnce(url: URL, options: SafePostOptions): Promise<{ statusCode: number; location: string | null }> {
  const transport = options.transport ?? request;
  return new Promise((resolve, reject) => {
    const req = transport(
      url,
      {
        method: "POST",
        headers: { ...options.headers, "content-length": String(Buffer.byteLength(options.body)) },
        timeout: options.timeoutMs ?? 5000,
        lookup: createSafeLookup() as never,
      },
      (res) => {
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        res.resume(); // descarta o corpo
        resolve({ statusCode: res.statusCode ?? 0, location });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(options.body);
  });
}
