import type { NextConfig } from "next";

const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // a CSP (com nonce por requisição) é montada no proxy.ts; HSTS só em produção (em dev o http://localhost não deve ficar preso)
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  transpilePackages: ["@duckzap/ui", "@duckzap/brand", "@duckzap/contracts", "@duckzap/api-client"],
  experimental: { serverActions: { bodySizeLimit: "16mb" } },
  // O navegador só precisa de login/sessão pelo mesmo domínio (cookie). Todo o resto (módulos de negócio, /v1/admin/*)
  // é chamado pelo servidor do Next (apiFetch), então NÃO é exposto aqui: lista de permitidos, não "/api/*".
  async rewrites() {
    return [
      { source: "/api/v1/auth/:path*", destination: `${apiUrl}/v1/auth/:path*` },
      { source: "/api/v1/me", destination: `${apiUrl}/v1/me` },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
