import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // painel interno: nunca indexar
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  // a CSP (com nonce por requisição) é montada no proxy.ts; HSTS só em produção
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  transpilePackages: ["@duckzap/ui", "@duckzap/brand", "@duckzap/contracts", "@duckzap/api-client"],
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
  // Sem rewrite de /api: o painel só fala com a API pelo servidor (apiFetch); o navegador não deve alcançar /v1/admin/* por aqui.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
