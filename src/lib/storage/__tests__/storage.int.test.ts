import { describe, expect, it } from "vitest";
import { env } from "@/lib/config/env";
import { createStorage, workspaceObjectKey } from "../index";

/** Runs against the local MinIO from `pnpm services:native` / docker compose. */
describe("storage", () => {
  const e = env();
  const storage = createStorage({
    endpoint: e.S3_ENDPOINT,
    region: e.S3_REGION,
    bucket: `${e.S3_BUCKET}-test`,
    accessKeyId: e.S3_ACCESS_KEY_ID,
    secretAccessKey: e.S3_SECRET_ACCESS_KEY,
  });

  it("builds keys under the workspace prefix and rejects traversal", () => {
    expect(workspaceObjectKey({ workspaceId: "wsA" }, "files", "abc.pdf")).toBe(
      "ws/wsA/files/abc.pdf",
    );
    expect(() => workspaceObjectKey({ workspaceId: "wsA" }, "..", "wsB")).toThrow(/Unsafe/);
    expect(() => workspaceObjectKey({ workspaceId: "wsA" }, "a/b")).toThrow(/Unsafe/);
  });

  it("stores and reads an object, isolated by workspace", async () => {
    await storage.ensureBucket();
    await storage.put({ workspaceId: "wsA" }, ["files", "note.txt"], "hello", "text/plain");
    expect(
      new TextDecoder().decode(await storage.get({ workspaceId: "wsA" }, ["files", "note.txt"])),
    ).toBe("hello");
    await expect(storage.get({ workspaceId: "wsB" }, ["files", "note.txt"])).rejects.toThrow();
  });

  it("signs short-lived download links as attachments", async () => {
    const url = new URL(
      await storage.signedDownloadUrl({ workspaceId: "wsA" }, ["files", "note.txt"], "note.txt"),
    );
    expect(url.pathname).toContain("/ws/wsA/files/note.txt");
    expect(url.searchParams.get("response-content-disposition")).toMatch(/^attachment/);
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(300);
  });
});
