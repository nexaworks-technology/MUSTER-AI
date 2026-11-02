import { randomBytes } from "node:crypto";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { z } from "zod";
import { env } from "@/lib/config/env";
import { rawDb } from "@/lib/db/raw";
import { createAuthAdapter } from "./adapter";
import { burnPasswordCheck, verifyPassword } from "./password";

/**
 * Auth.js v5 with Google + email/password and DATABASE sessions (DECISIONS D-07).
 *
 * Auth.js always runs the credentials flow through `callbacks.jwt` → `jwt.encode` and stores
 * the encoded value in the session cookie. We keep the database strategy by creating the
 * `Session` row in the jwt callback and making `encode` return that row's sessionToken, so the
 * cookie holds an opaque database token exactly like an OAuth sign-in. `decode` returns null:
 * no JWT is ever read; sessions are always loaded from the database by the adapter.
 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function isGoogleConfigured(): boolean {
  const { AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET } = env();
  return Boolean(AUTH_GOOGLE_ID && AUTH_GOOGLE_SECRET);
}

const credentialsInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(512),
});

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const adapter = createAuthAdapter();
  return {
    adapter,
    secret: env().AUTH_SECRET,
    trustHost: true,
    session: { strategy: "database", maxAge: SESSION_MAX_AGE_SECONDS },
    pages: { signIn: "/sign-in", error: "/sign-in" },
    providers: [
      // Registered from env only. When unconfigured, the button is hidden and the route 404s
      // (src/app/api/auth/[...nextauth]/route.ts). Registering it also keeps the provider list
      // from being credentials-only, which Auth.js rejects for database sessions.
      Google({ clientId: env().AUTH_GOOGLE_ID, clientSecret: env().AUTH_GOOGLE_SECRET }),
      Credentials({
        id: "credentials",
        credentials: { email: {}, password: {} },
        async authorize(raw) {
          const parsed = credentialsInput.safeParse(raw);
          if (!parsed.success) return null;
          const { email, password } = parsed.data;
          const user = await rawDb.user.findUnique({ where: { email } });
          if (!user?.passwordHash) {
            await burnPasswordCheck(password);
            return null;
          }
          if (!(await verifyPassword(user.passwordHash, password))) return null;
          return { id: user.id, email: user.email, name: user.name };
        },
      }),
    ],
    callbacks: {
      async signIn({ account, user }) {
        if (account?.provider !== "google") return true;
        // Google sign-in is for people who already have an account here (invited or created by
        // an admin). It never creates new users on its own.
        if (!isGoogleConfigured() || !user.email) return false;
        return Boolean(await rawDb.user.findUnique({ where: { email: user.email.toLowerCase() } }));
      },
      async jwt({ token, user, account, trigger }) {
        if (trigger !== "signIn" || account?.provider !== "credentials" || !user?.id) return token;
        const sessionToken = randomBytes(32).toString("base64url");
        await adapter.createSession!({
          sessionToken,
          userId: user.id,
          expires: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
        });
        return { sessionToken };
      },
      session({ session, user }) {
        return { ...session, user: { ...session.user, id: user.id } };
      },
    },
    jwt: {
      async encode({ token }) {
        const sessionToken = token?.sessionToken;
        if (typeof sessionToken !== "string") {
          throw new Error("Credentials sign-in did not create a database session");
        }
        return sessionToken;
      },
      async decode() {
        return null;
      },
    },
  };
});
