/**
 * Malware scanning hook (ARCHITECTURE §7.6, QUESTIONS Q-18). Development and test use a no-op
 * scanner that marks files clean. In production no scanner is configured yet, so files stay
 * PENDING and cannot be downloaded or processed until one is (M12 wires a real scanner).
 */
export interface MalwareScanner {
  readonly name: string;
  scan(bytes: Uint8Array): Promise<"CLEAN" | "REJECTED">;
}

const devNoop: MalwareScanner = { name: "dev-noop", scan: async () => "CLEAN" };

export function getScanner(nodeEnv = process.env.NODE_ENV): MalwareScanner | null {
  return nodeEnv === "production" ? null : devNoop;
}
