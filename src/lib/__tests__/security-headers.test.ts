import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { authCookies } from "@/lib/security/cookies";
import { buildCsp, buildSecurityHeaders, generateNonce } from "@/lib/security/headers";
import { proxy } from "@/proxy";

function directives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values);
  }
  return map;
}

describe("security headers (builder)", () => {
  const nonce = "dGVzdC1ub25jZQ==";

  it("builds the fixed headers for production, with HSTS", () => {
    const h = buildSecurityHeaders({ nonce, production: true });
    expect(h["Strict-Transport-Security"]).toBe("max-age=63072000; includeSubDomains");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Permissions-Policy"]).toBe("camera=(), geolocation=(), microphone=(self)");
    expect(h["Content-Security-Policy"]).toContain(`'nonce-${nonce}'`);
  });

  it("omits HSTS outside production", () => {
    const h = buildSecurityHeaders({ nonce, production: false });
    expect(h["Strict-Transport-Security"]).toBeUndefined();
    expect(h["X-Frame-Options"]).toBe("DENY");
  });

  it("CSP is strict: the fixed directives, a nonce for scripts, no unsafe-* on scripts in production", () => {
    const d = directives(buildCsp({ nonce, production: true }));
    expect(d.get("default-src")).toEqual(["'self'"]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'self'"]);
    expect(d.get("form-action")).toEqual(["'self'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(d.get("connect-src")).toEqual(["'self'"]);
    expect(d.get("script-src")).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]);
    expect(d.get("style-src")).toEqual(["'self'", `'nonce-${nonce}'`]);
    expect(d.get("script-src")).not.toContain("'unsafe-inline'");
    expect(d.get("script-src")).not.toContain("'unsafe-eval'");
    expect(d.has("upgrade-insecure-requests")).toBe(true);
  });

  it("allows unsafe-eval for scripts in development only (React debugging), and no upgrade", () => {
    const d = directives(buildCsp({ nonce, production: false }));
    expect(d.get("script-src")).toContain("'unsafe-eval'");
    expect(d.has("upgrade-insecure-requests")).toBe(false);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("only inline style attributes are allowed to be unsafe-inline, never style elements or scripts", () => {
    const d = directives(buildCsp({ nonce, production: true }));
    expect(d.get("style-src-attr")).toEqual(["'unsafe-inline'"]);
    expect(d.get("style-src")).not.toContain("'unsafe-inline'");
  });

  it("development alone allows inline style elements (Next dev CSS injection); production never", () => {
    expect(directives(buildCsp({ nonce, production: false })).get("style-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
    ]);
    expect(directives(buildCsp({ nonce, production: true })).get("style-src")).toEqual([
      "'self'",
      `'nonce-${nonce}'`,
    ]);
  });

  it("generates a fresh base64 nonce each time", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(a.length).toBeGreaterThanOrEqual(22);
  });
});

describe("proxy (every response)", () => {
  for (const path of ["/", "/sign-in", "/portal/abc123", "/api/health", "/unsubscribe/x"]) {
    it(`sets the headers and forwards the nonce for ${path}`, () => {
      const res = proxy(new NextRequest(`http://localhost:3000${path}`));
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toMatch(/script-src 'self' 'nonce-[^']+'/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("permissions-policy")).toContain("microphone=(self)");
      // The request header Next reads the nonce from is forwarded on the request, via the
      // override header list NextResponse.next({ request }) writes.
      expect(res.headers.get("x-middleware-override-headers")).toContain("content-security-policy");
    });
  }

  it("uses a different nonce per request", () => {
    const get = () =>
      /nonce-([^']+)/.exec(
        proxy(new NextRequest("http://localhost:3000/")).headers.get("content-security-policy") ??
          "",
      )?.[1];
    expect(get()).not.toBe(get());
  });
});

describe("auth cookies", () => {
  it("production: Secure, HttpOnly, SameSite=Lax, __Secure-/__Host- prefixes", () => {
    const c = authCookies(true);
    expect(c.sessionToken.name).toBe("__Secure-authjs.session-token");
    expect(c.csrfToken.name).toBe("__Host-authjs.csrf-token");
    expect(c.callbackUrl.name).toBe("__Secure-authjs.callback-url");
    expect(c.pkceCodeVerifier.name).toBe("__Secure-authjs.pkce.code_verifier");
    expect(c.state.name).toBe("__Secure-authjs.state");
    expect(c.nonce.name).toBe("__Secure-authjs.nonce");
    for (const cookie of Object.values(c)) {
      expect(cookie.options).toMatchObject({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: true,
      });
    }
  });

  it("development: plain names and not Secure (http://localhost), still HttpOnly + Lax", () => {
    const c = authCookies(false);
    expect(c.sessionToken.name).toBe("authjs.session-token");
    for (const cookie of Object.values(c)) {
      expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false });
    }
  });
});

describe("transport hardening (M12 B7, D-182)", () => {
  it("the localhost e2e production build keeps the strict CSP but drops HSTS and upgrade-insecure", () => {
    const h = buildSecurityHeaders({ nonce: "n", production: true, transportHardening: false });
    expect(h["Strict-Transport-Security"]).toBeUndefined();
    expect(h["Content-Security-Policy"]).not.toContain("upgrade-insecure-requests");
    expect(h["Content-Security-Policy"]).toContain("style-src 'self' 'nonce-n'");
    expect(h["Content-Security-Policy"]).not.toContain("unsafe-eval");
  });
  it("a real production deployment gets both by default", () => {
    const h = buildSecurityHeaders({ nonce: "n", production: true });
    expect(h["Strict-Transport-Security"]).toContain("max-age=");
    expect(h["Content-Security-Policy"]).toContain("upgrade-insecure-requests");
  });
});
