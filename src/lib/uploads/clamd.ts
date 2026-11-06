import { connect, type Socket } from "node:net";
import type { MalwareScanner } from "./scanner";

/**
 * ClamAV `clamd` client over `node:net` (Q-18, ARCHITECTURE §7.6). Speaks the null-terminated
 * command protocol: `zINSTREAM\0`, then chunks of <4-byte big-endian length><data>, then a
 * zero-length chunk. Only `stream: OK` is CLEAN. Any error, timeout, size-limit reply or
 * unrecognised answer throws {@link ScannerUnavailableError}: callers keep the file PENDING and
 * never treat an error as a clean verdict.
 */
export class ScannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScannerUnavailableError";
  }
}

export interface ClamdOptions {
  host?: string;
  port?: number;
  /** Unix socket path; takes precedence over host/port. */
  socket?: string;
  /** Whole-exchange timeout (connect + send + reply). Default 30s. */
  timeoutMs?: number;
  /** Bytes per INSTREAM chunk. Default 64 KiB. */
  chunkSize?: number;
}

export interface ClamdScanner extends MalwareScanner {
  /** True when clamd answers PING with PONG. Never throws. */
  ping(): Promise<boolean>;
}

const DEFAULT_PORT = 3310;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CHUNK = 64 * 1024;

/** Open a connection, send via `write`, and resolve with clamd's full null-terminated reply. */
function exchange(opts: ClamdOptions, write: (socket: Socket) => Promise<void>): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = opts.socket
      ? connect({ path: opts.socket })
      : connect({ host: opts.host ?? "127.0.0.1", port: opts.port ?? DEFAULT_PORT });
    const parts: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new ScannerUnavailableError(`clamd did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const reply = Buffer.concat(parts).toString("utf8").replace(/\0+$/, "").trim();
      if (reply) resolve(reply);
      else
        reject(err ?? new ScannerUnavailableError("clamd closed the connection without a reply"));
    };
    socket.on("data", (d) => {
      parts.push(d);
      if (d.includes(0)) finish(null);
    });
    socket.on("end", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("error", (e) =>
      finish(new ScannerUnavailableError(`clamd connection failed: ${e.message}`)),
    );
    // A write failure (e.g. clamd hangs up after a size-limit reply) surfaces through the
    // socket's own error/close events, where any reply already received is still used.
    socket.on("connect", () => void write(socket).catch(() => undefined));
  });
}

function writeAll(socket: Socket, data: Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve();
    if (socket.write(data)) return resolve();
    const done = () => {
      socket.off("drain", done);
      socket.off("close", done);
      resolve();
    };
    socket.once("drain", done);
    socket.once("close", done);
  });
}

export function createClamdScanner(opts: ClamdOptions): ClamdScanner {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  return {
    name: "clamd",
    async scan(bytes) {
      const reply = await exchange(opts, async (socket) => {
        await writeAll(socket, Buffer.from("zINSTREAM\0", "latin1"));
        for (let off = 0; off < bytes.length; off += chunkSize) {
          const chunk = Buffer.from(bytes.subarray(off, off + chunkSize));
          const head = Buffer.alloc(4);
          head.writeUInt32BE(chunk.length);
          await writeAll(socket, Buffer.concat([head, chunk]));
          if (socket.destroyed) return;
        }
        await writeAll(socket, Buffer.alloc(4));
      });
      if (reply === "stream: OK") return "CLEAN";
      if (/^stream: .+ FOUND$/.test(reply)) return "REJECTED";
      throw new ScannerUnavailableError(`clamd returned an unusable reply: ${reply.slice(0, 120)}`);
    },
    async ping() {
      try {
        const timeoutMs = Math.min(opts.timeoutMs ?? 5_000, 5_000);
        const reply = await exchange({ ...opts, timeoutMs }, (s) =>
          writeAll(s, Buffer.from("zPING\0", "latin1")),
        );
        return reply === "PONG";
      } catch {
        return false;
      }
    },
  };
}
