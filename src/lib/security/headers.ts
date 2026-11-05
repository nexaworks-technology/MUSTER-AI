/**
 * Security response headers (ARCHITECTURE §7, M12 A8). Pure functions: `src/proxy.ts` calls them
 * on every request. Nothing here reads env or the request.
 *
 * Why these CSP choices:
 * - script-src uses a per-request nonce + 'strict-dynamic'. Next 16 reads the nonce from the
 *   request's CSP header and stamps its own scripts, so no 'unsafe-inline' is needed. This needs
 *   dynamic rendering (the root layout is `force-dynamic`).
 * - style-src uses the same nonce, with NO 'unsafe-inline'. Only `style-src-attr` allows
 *   'unsafe-inline': React `style={{…}}` props (progress bars, chart sizing) render as inline style
 *   attributes, which a nonce cannot cover. Attribute styles cannot run script, so this is the
 *   narrowest relaxation.
 * - 'unsafe-eval' only in development: React uses eval for server-stack reconstruction there.
 * - microphone=(self): the Ask AI dictation feature (M11 S12) uses the browser microphone.
 * - frame-ancestors 'none' + X-Frame-Options DENY everywhere, including the customer portal and
 *   survey pages: nothing in the product is meant to be embedded.
 */
export interface HeaderOptions {
  nonce: string;
  production: boolean;
}

export function generateNonce(): string {
  return btoa(crypto.randomUUID());
}

export function buildCsp({ nonce, production }: HeaderOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? "" : " 'unsafe-eval'"}`,
    // Development only: Next's dev server injects <style> elements without the nonce (CSS HMR),
    // so dev allows inline styles (a nonce would make browsers ignore 'unsafe-inline'). Production
    // serves CSS as stylesheet links and stays nonce-only; proven in the production-build e2e (B7).
    production ? `style-src 'self' 'nonce-${nonce}'` : "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (production) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function buildSecurityHeaders(options: HeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": buildCsp(options),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(self)",
  };
  if (options.production) {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  }
  return headers;
}
