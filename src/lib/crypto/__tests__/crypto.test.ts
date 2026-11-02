import { describe, expect, it } from "vitest";
import { createFieldCipher } from "../index";

const key = (fill: number) => `k${fill}:${Buffer.alloc(32, fill).toString("base64")}`;

describe("field encryption (AES-256-GCM)", () => {
  const cipher = createFieldCipher(key(1));

  it("round-trips text and tags ciphertext with the key id", () => {
    const sealed = cipher.encrypt("refresh-token-value");
    expect(sealed.startsWith("k1.")).toBe(true);
    expect(sealed).not.toContain("refresh-token-value");
    expect(cipher.decrypt(sealed)).toBe("refresh-token-value");
  });

  it("uses a fresh IV every time", () => {
    expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"));
  });

  it("detects tampering", () => {
    const sealed = cipher.encrypt("value");
    const [id, body] = sealed.split(".") as [string, string];
    const bytes = Buffer.from(body, "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt(`${id}.${bytes.toString("base64url")}`)).toThrow();
  });

  it("refuses ciphertext from an unknown key id", () => {
    const other = createFieldCipher(key(2));
    expect(() => cipher.decrypt(other.encrypt("x"))).toThrow(/unknown key id/);
  });

  it("decrypts with retired keys kept for rotation", () => {
    const old = createFieldCipher(key(2));
    const rotated = createFieldCipher(key(3), [key(2)]);
    expect(rotated.decrypt(old.encrypt("kept"))).toBe("kept");
    expect(rotated.encrypt("new").startsWith("k3.")).toBe(true);
  });

  it("passes null through", () => {
    expect(cipher.encryptNullable(null)).toBeNull();
    expect(cipher.decryptNullable(undefined)).toBeNull();
  });
});
