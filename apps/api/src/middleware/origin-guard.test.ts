import { describe, expect, it } from "vitest";
import { checkOrigin } from "./origin-guard";

const allowed = ["http://localhost:3000", "http://localhost:3002"];
const base = {
  method: "POST",
  path: "/v1/team/invites",
  origin: undefined,
  secFetchSite: undefined,
  contentType: "application/json",
  allowedOrigins: allowed,
} as const;

describe("guarda de origem (CSRF)", () => {
  it("GET/HEAD/OPTIONS passam sem olhar a origem", () => {
    expect(checkOrigin({ ...base, method: "GET", origin: "https://evil.example" }).allowed).toBe(true);
    expect(checkOrigin({ ...base, method: "OPTIONS", origin: "https://evil.example" }).allowed).toBe(true);
  });

  it("escrita com Origin de fora é 403; com Origin conhecido passa", () => {
    expect(checkOrigin({ ...base, origin: "https://evil.example" })).toMatchObject({ allowed: false, status: 403 });
    expect(checkOrigin({ ...base, origin: "null" })).toMatchObject({ allowed: false, status: 403 });
    expect(checkOrigin({ ...base, origin: "http://localhost:3000" }).allowed).toBe(true);
    expect(checkOrigin({ ...base, origin: "http://localhost:3002" }).allowed).toBe(true);
  });

  it("sem Origin passa (servidor/curl), mas navegador cross-site é barrado", () => {
    expect(checkOrigin({ ...base }).allowed).toBe(true);
    expect(checkOrigin({ ...base, secFetchSite: "cross-site" })).toMatchObject({ allowed: false, status: 403 });
  });

  it("formulário clássico (urlencoded/text/plain) é 415 mesmo com origem conhecida", () => {
    expect(checkOrigin({ ...base, origin: "http://localhost:3000", contentType: "application/x-www-form-urlencoded" })).toMatchObject({
      allowed: false,
      status: 415,
    });
    expect(checkOrigin({ ...base, contentType: "text/plain;charset=UTF-8" })).toMatchObject({ allowed: false, status: 415 });
    expect(checkOrigin({ ...base, contentType: undefined }).allowed).toBe(true);
  });

  it("webhooks de provedor e o painel admin (guarda própria) são ignorados", () => {
    expect(checkOrigin({ ...base, path: "/v1/webhooks/wa/evolution/dzwh_x", contentType: "text/plain" }).allowed).toBe(true);
    expect(checkOrigin({ ...base, path: "/v1/admin/auth/sign-in", origin: "https://evil.example" }).allowed).toBe(true);
  });
});
