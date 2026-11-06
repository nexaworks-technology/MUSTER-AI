import { describe, expect, it } from "vitest";
import { createClamdScanner, ScannerUnavailableError, type ClamdOptions } from "../clamd";

/** Real clamd. Skipped unless CLAMD_HOST or CLAMD_SOCKET is set (start one: scripts/clamd-local.sh). */
const configured = Boolean(process.env.CLAMD_HOST || process.env.CLAMD_SOCKET);
const opts: ClamdOptions = {
  host: process.env.CLAMD_HOST,
  port: process.env.CLAMD_PORT ? Number(process.env.CLAMD_PORT) : undefined,
  socket: process.env.CLAMD_SOCKET,
};

// Assembled from fragments so no antivirus flags this source file.
const eicar = () =>
  Buffer.from(
    ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE", "!$H+H*"].join(""),
    "latin1",
  );

if (!configured) {
  console.warn(
    "SKIPPED clamd.int.test.ts: set CLAMD_HOST (or CLAMD_SOCKET) to run against a real clamd",
  );
}

describe.skipIf(!configured)("real clamd", () => {
  const scanner = createClamdScanner({ ...opts, timeoutMs: 30_000 });

  it("answers PING with PONG", async () => {
    expect(await scanner.ping()).toBe(true);
  });
  it("a clean buffer is CLEAN", async () => {
    expect(await scanner.scan(Buffer.from("hello, this is a harmless contract\n"))).toBe("CLEAN");
  });
  it("the EICAR test string is REJECTED", async () => {
    expect(await scanner.scan(eicar())).toBe("REJECTED");
  });
  it("a payload over StreamMaxLength is an error, never CLEAN", async () => {
    // Needs a clamd with a small StreamMaxLength (scripts/clamd-local.sh sets 1M).
    const big = Buffer.alloc(3 * 1024 * 1024, 65);
    await expect(scanner.scan(big)).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
  it("an unreachable clamd is ScannerUnavailableError", async () => {
    const dead = createClamdScanner({ host: "127.0.0.1", port: 1, timeoutMs: 2_000 });
    await expect(dead.scan(Buffer.from("x"))).rejects.toBeInstanceOf(ScannerUnavailableError);
    expect(await dead.ping()).toBe(false);
  });
});
