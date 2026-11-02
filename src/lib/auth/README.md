# Auth

Auth.js v5 with **database sessions** for both Google and email/password (DECISIONS D-07, D-08).

## Email/password with database sessions

Auth.js only issues JWT sessions for its Credentials provider. We keep the database strategy:

1. `authorize()` only verifies the email and argon2id password hash.
2. Auth.js then always calls `callbacks.jwt` (with `trigger: "signIn"`). For credentials logins, that callback
   creates a `Session` row with a random 32-byte token through the adapter, and returns `{ sessionToken }`.
3. `jwt.encode` returns that token unchanged. Auth.js writes it into the standard session cookie
   (`authjs.session-token`, or the `__Secure-` name over HTTPS: httpOnly, sameSite=lax).
4. `jwt.decode` always returns `null`. With `session.strategy = "database"`, Auth.js loads sessions with
   `adapter.getSessionAndUser(cookie)`, so no JWT is ever read.
5. Signing out (or deleting the row) ends the session immediately.

Proof: `__tests__/credentials-session.int.test.ts` drives the real route handlers.

## Google

- Registered from `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` only. Without them, the sign-in button is hidden
  and `/api/auth/(signin|callback)/google` return 404.
- Registering it also keeps the provider list from being credentials-only, which Auth.js forbids
  with database sessions.
- Google sign-in never creates users. It works only for an email that already has an account.

## Adapter (D-08)

`adapter.ts` wraps `@auth/prisma-adapter`, but stores linked accounts in `AuthAccount` with encrypted
tokens and normalises emails to lower case.

## Workspace context

`session.ts → getWorkspaceContext()` resolves the active workspace from the user's own
memberships (the `membership_self_read` RLS policy) and never from client input.
