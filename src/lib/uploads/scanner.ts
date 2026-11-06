/**
 * Malware scanning hook (ARCHITECTURE §7.6, QUESTIONS Q-18). Development and test use a no-op
 * scanner that marks files clean unless CLAMD_* is set. Production uses clamd (the env schema
 * refuses to boot without CLAMD_HOST or CLAMD_SOCKET); if none is configured, files stay PENDING
 * and cannot be downloaded or processed. A scanner that throws ScannerUnavailableError also
 * leaves the file PENDING (files/service.ts); an error is never a clean verdict.
 */
import { testSeamsAllowed } from "@/lib/config/deployment";
import { createClamdScanner } from "./clamd";

export interface MalwareScanner {
  readonly name: string;
  scan(bytes: Uint8Array): Promise<"CLEAN" | "REJECTED">;
}

const devNoop: MalwareScanner = { name: "dev-noop", scan: async () => "CLEAN" };

type ScannerEnv = Record<string, string | undefined>;

export function getScanner(
  nodeEnv = process.env.NODE_ENV,
  source: ScannerEnv = process.env,
): MalwareScanner | null {
  const host = source.CLAMD_HOST?.trim() || undefined;
  const socket = source.CLAMD_SOCKET?.trim() || undefined;
  if (host || socket) {
    const port = source.CLAMD_PORT ? Number(source.CLAMD_PORT) : undefined;
    const timeoutMs = source.CLAMD_TIMEOUT_MS ? Number(source.CLAMD_TIMEOUT_MS) : undefined;
    return createClamdScanner({ host, port, socket, timeoutMs });
  }
  return nodeEnv === "production" && !testSeamsAllowed({ ...source, NODE_ENV: nodeEnv })
    ? null
    : devNoop;
}
