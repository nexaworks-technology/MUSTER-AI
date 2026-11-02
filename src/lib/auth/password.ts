import { hash, verify } from "@node-rs/argon2";

export { MIN_PASSWORD_LENGTH } from "./constants";

/** argon2id (the library default algorithm) with OWASP-recommended cost parameters. */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Constant-ish work for unknown emails, so response time does not reveal which emails exist. */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("not-a-real-password-placeholder");
  await verifyPassword(await dummyHash, password);
}
