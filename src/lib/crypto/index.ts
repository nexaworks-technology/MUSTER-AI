import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/config/env";

/**
 * Application-level field encryption: AES-256-GCM, output `<keyId>.<base64url(iv|tag|ciphertext)>`
 * (ARCHITECTURE §7.5). The key id prefix lets old ciphertext be read after a key rotation.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface FieldCipher {
  encrypt(plaintext: string): string;
  decrypt(sealed: string): string;
  encryptNullable(plaintext: string | null | undefined): string | null;
  decryptNullable(sealed: string | null | undefined): string | null;
}

function parseKey(spec: string): { id: string; key: Buffer } {
  const sep = spec.indexOf(":");
  const id = spec.slice(0, sep);
  const key = Buffer.from(spec.slice(sep + 1), "base64");
  if (sep < 1 || key.length !== 32)
    throw new Error("Encryption key must be <keyId>:<base64 32-byte key>");
  return { id, key };
}

export function createFieldCipher(
  currentKey: string,
  retiredKeys: readonly string[] = [],
): FieldCipher {
  const current = parseKey(currentKey);
  const keys = new Map([...retiredKeys.map(parseKey), current].map((k) => [k.id, k.key]));

  const encrypt = (plaintext: string): string => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", current.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    return `${current.id}.${sealed.toString("base64url")}`;
  };

  const decrypt = (sealed: string): string => {
    const dot = sealed.indexOf(".");
    const key = keys.get(sealed.slice(0, dot));
    if (dot < 1 || !key) throw new Error("Cannot decrypt: unknown key id");
    const bytes = Buffer.from(sealed.slice(dot + 1), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  };

  return {
    encrypt,
    decrypt,
    encryptNullable: (p) => (p == null ? null : encrypt(p)),
    decryptNullable: (s) => (s == null ? null : decrypt(s)),
  };
}

let cached: FieldCipher | undefined;

/** The workspace-wide field cipher built from FIELD_ENCRYPTION_KEY. */
export function fieldCipher(): FieldCipher {
  cached ??= createFieldCipher(env().FIELD_ENCRYPTION_KEY);
  return cached;
}
