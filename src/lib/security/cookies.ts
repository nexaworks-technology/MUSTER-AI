import type { NextAuthConfig } from "next-auth";

type CookiesOptions = NonNullable<NextAuthConfig["cookies"]>;
type CookieName = keyof CookiesOptions;
type AuthCookies = Required<{ [K in CookieName]: NonNullable<CookiesOptions[K]> }>;

/**
 * Auth.js cookie names and flags, set explicitly rather than left to library defaults
 * (M12 A8). Every cookie is HttpOnly + SameSite=Lax; in production they are Secure and carry the
 * `__Secure-` prefix, and the CSRF token the `__Host-` prefix (no Domain, Path=/).
 * The session cookie name must match SESSION_COOKIE_NAMES in `src/lib/auth/session.ts`.
 */
export function authCookies(production: boolean): AuthCookies {
  const options = { httpOnly: true, sameSite: "lax", path: "/", secure: production } as const;
  const secure = production ? "__Secure-" : "";
  const host = production ? "__Host-" : "";
  return {
    sessionToken: { name: `${secure}authjs.session-token`, options },
    callbackUrl: { name: `${secure}authjs.callback-url`, options },
    csrfToken: { name: `${host}authjs.csrf-token`, options },
    pkceCodeVerifier: { name: `${secure}authjs.pkce.code_verifier`, options },
    state: { name: `${secure}authjs.state`, options },
    nonce: { name: `${secure}authjs.nonce`, options },
    webauthnChallenge: { name: `${secure}authjs.challenge`, options },
  };
}
