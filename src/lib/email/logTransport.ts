import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "@/lib/logger";
import type { EmailTransport, StaffEmail } from "./types";

/**
 * Development/test transport: writes each message to `.dev-mail/<time>-<id>.json` (git-ignored)
 * and logs only the file path and subject. Refused in production by the env schema.
 */
export function createLogTransport(dir = path.join(process.cwd(), ".dev-mail")): EmailTransport {
  return {
    name: "log",
    async send(message: StaffEmail) {
      const id = randomUUID();
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().replaceAll(":", "-")}-${id}.json`);
      await writeFile(file, JSON.stringify({ id, ...message }, null, 2));
      logger.info({ emailId: id, file, subject: message.subject }, "dev email written");
      return { id };
    },
  };
}
