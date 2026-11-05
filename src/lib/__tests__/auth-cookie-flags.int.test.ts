import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { authCookies } from "@/lib/security/cookies";

describe("Auth.js really issues its cookies with the production options", () => {
  it("CSRF cookie over https is __Host-, Secure, HttpOnly, SameSite=Lax, Path=/", async () => {
    const { handlers } = NextAuth({
      secret: "x".repeat(32),
      trustHost: true,
      useSecureCookies: true,
      cookies: authCookies(true),
      providers: [Credentials({ credentials: {}, authorize: () => null })],
    });
    const res = await handlers.GET(new NextRequest("https://app.example.test/api/auth/csrf"));
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/__Host-authjs\.csrf-token=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/Path=\//i);
  });
});
