import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";
import { fieldCipher } from "@/lib/crypto";
import { rawDb } from "@/lib/db/raw";

/**
 * Auth.js adapter (DECISIONS D-08): the stock Prisma adapter, except that linked OAuth accounts
 * live in `AuthAccount` (our `Account` is a customer account) and OAuth tokens are stored
 * encrypted. Emails are normalised to lower case. WebAuthn methods are not exposed.
 */
function sealTokens(account: AdapterAccount): AdapterAccount {
  const seal = (value: unknown) =>
    typeof value === "string" ? fieldCipher().encrypt(value) : undefined;
  return {
    ...account,
    refresh_token: seal(account.refresh_token),
    access_token: seal(account.access_token),
    id_token: seal(account.id_token),
  };
}

function toAdapterUser(
  user: Awaited<ReturnType<typeof rawDb.user.findUnique>>,
): AdapterUser | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    emailVerified: user.emailVerified,
  };
}

export function createAuthAdapter(): Adapter {
  const base = PrismaAdapter(rawDb);
  return {
    ...base,
    createUser: async ({ id: _id, ...data }) =>
      toAdapterUser(
        await rawDb.user.create({ data: { ...data, email: data.email.toLowerCase() } }),
      )!,
    getUserByEmail: async (email) =>
      toAdapterUser(await rawDb.user.findUnique({ where: { email: email.toLowerCase() } })),
    async getUserByAccount({ provider, providerAccountId }) {
      const account = await rawDb.authAccount.findUnique({
        where: { provider_providerAccountId: { provider, providerAccountId } },
        include: { user: true },
      });
      return toAdapterUser(account?.user ?? null);
    },
    async linkAccount(account) {
      const { userId, type, provider, providerAccountId, ...rest } = sealTokens(account);
      await rawDb.authAccount.create({
        data: {
          userId,
          type,
          provider,
          providerAccountId,
          refresh_token: rest.refresh_token ?? null,
          access_token: rest.access_token ?? null,
          expires_at: rest.expires_at ?? null,
          token_type: rest.token_type ?? null,
          scope: rest.scope ?? null,
          id_token: rest.id_token ?? null,
          session_state: typeof rest.session_state === "string" ? rest.session_state : null,
        },
      });
    },
    async unlinkAccount({ provider, providerAccountId }) {
      await rawDb.authAccount.delete({
        where: { provider_providerAccountId: { provider, providerAccountId } },
      });
    },
    getAccount: async (providerAccountId, provider) =>
      (await rawDb.authAccount.findFirst({
        where: { providerAccountId, provider },
      })) as AdapterAccount | null,
    createAuthenticator: undefined,
    getAuthenticator: undefined,
    listAuthenticatorsByUserId: undefined,
    updateAuthenticatorCounter: undefined,
  };
}
