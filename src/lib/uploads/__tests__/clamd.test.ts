import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createClamdScanner, ScannerUnavailableError } from "../clamd";
import { getScanner } from "../scanner";

type Handler = (socket: Socket, received: Buffer[]) => void;
let server: Server | undefined;
const received: Buffer[] = [];

async function fake(handler: Handler): Promise<number> {
  received.length = 0;
  server = createServer((socket) => {
    socket.on("data", (d) => received.push(d));
    socket.on("error", () => undefined);
    handler(socket, received);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}

/** Replies once the terminating zero-length chunk has arrived. */
function replyAfterTerminator(reply: string): Handler {
  return (socket, chunks) => {
    socket.on("data", () => {
      const all = Buffer.concat(chunks);
      if (all.subarray(all.length - 4).equals(Buffer.alloc(4))) socket.end(reply);
    });
  };
}

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe("clamd scanner protocol", () => {
  it("frames zINSTREAM with big-endian length chunks and a zero terminator", async () => {
    const port = await fake(replyAfterTerminator("stream: OK\0"));
    const scanner = createClamdScanner({ host: "127.0.0.1", port, chunkSize: 4 });
    const verdict = await scanner.scan(Buffer.from("abcdefghij"));
    expect(verdict).toBe("CLEAN");
    const all = Buffer.concat(received);
    expect(all.subarray(0, 10).toString("latin1")).toBe("zINSTREAM\0");
    const body = all.subarray(10);
    const expected = Buffer.concat([
      Buffer.from([0, 0, 0, 4]),
      Buffer.from("abcd"),
      Buffer.from([0, 0, 0, 4]),
      Buffer.from("efgh"),
      Buffer.from([0, 0, 0, 2]),
      Buffer.from("ij"),
      Buffer.alloc(4),
    ]);
    expect(body.equals(expected)).toBe(true);
  });

  it("maps 'stream: <name> FOUND' to REJECTED", async () => {
    const port = await fake(replyAfterTerminator("stream: Win.Test.EICAR_HDB-1 FOUND\0"));
    const scanner = createClamdScanner({ host: "127.0.0.1", port });
    expect(await scanner.scan(Buffer.from("x"))).toBe("REJECTED");
  });

  it.each([
    "INSTREAM size limit exceeded. ERROR\0",
    "stream: Can't allocate memory ERROR\0",
    "garbage\0",
  ])("treats %j as scanner unavailable, never CLEAN", async (reply) => {
    const port = await fake(replyAfterTerminator(reply));
    const scanner = createClamdScanner({ host: "127.0.0.1", port });
    await expect(scanner.scan(Buffer.from("x"))).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it("times out when clamd never answers", async () => {
    const port = await fake(() => undefined);
    const scanner = createClamdScanner({ host: "127.0.0.1", port, timeoutMs: 150 });
    await expect(scanner.scan(Buffer.from("x"))).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it("connection refused is scanner unavailable", async () => {
    const port = await fake(() => undefined);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const scanner = createClamdScanner({ host: "127.0.0.1", port });
    await expect(scanner.scan(Buffer.from("x"))).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it("ping returns true on PONG and false otherwise", async () => {
    let port = await fake((socket) => socket.on("data", () => socket.end("PONG\0")));
    expect(await createClamdScanner({ host: "127.0.0.1", port }).ping()).toBe(true);
    await new Promise<void>((r) => server!.close(() => r()));
    port = await fake((socket) => socket.on("data", () => socket.end("nope\0")));
    expect(await createClamdScanner({ host: "127.0.0.1", port }).ping()).toBe(false);
  });
});

describe("getScanner selection", () => {
  it("production with no clamd configured has no scanner", () => {
    expect(getScanner("production", {})).toBeNull();
  });
  it("production with CLAMD_HOST uses clamd", () => {
    expect(getScanner("production", { CLAMD_HOST: "clamav" })?.name).toBe("clamd");
  });
  it("development stays no-op unless CLAMD_* is set", () => {
    expect(getScanner("development", {})?.name).toBe("dev-noop");
    expect(getScanner("test", { CLAMD_SOCKET: "/tmp/x.sock" })?.name).toBe("clamd");
  });
});
