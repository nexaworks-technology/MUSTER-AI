import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/config/env";
import { realClock } from "@/lib/dates";
import { slackApi } from "../adapters/slack";
import type { HttpTransport } from "../transport";

/**
 * Slack delivery (founder D4, D-95). Internal messages only, never customer content and never
 * through customer `dispatch`. "log" (development, test, e2e, demo) writes each message as one
 * JSON file in `.dev-slack/`; "live" posts with the workspace's bot token. The token is passed in
 * by the caller and never written to the log file.
 */
export interface SlackMessage {
  /** A Slack user id (a DM from the app) or a channel id. */
  channel: string;
  text: string;
  blocks?: unknown[];
}

export interface SlackDelivery {
  readonly mode: "log" | "live";
  post(workspaceId: string, message: SlackMessage, token: string | undefined): Promise<void>;
}

export const SLACK_LOG_DIR = path.join(process.cwd(), ".dev-slack");

export function logDelivery(dir = SLACK_LOG_DIR): SlackDelivery {
  return {
    mode: "log",
    async post(workspaceId, message) {
      await mkdir(dir, { recursive: true });
      const at = realClock().toISOString();
      const file = path.join(dir, `${at.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`);
      await writeFile(file, JSON.stringify({ at, workspaceId, ...message }, null, 2));
    },
  };
}

export function liveDelivery(transport: HttpTransport): SlackDelivery {
  return {
    mode: "live",
    async post(_workspaceId, message, token) {
      await slackApi(
        transport,
        token,
        "chat.postMessage",
        { ...message },
        z.object({ ok: z.literal(true) }).passthrough(),
      );
    },
  };
}

export function deliveryFor(transport: () => HttpTransport): SlackDelivery {
  return env().SLACK_DELIVERY === "live" ? liveDelivery(transport()) : logDelivery();
}
