import { z } from "zod";

/**
 * The Usage API's Segment-compatible subset (M6 §2): `track`, `identify` and `batch` with
 * `userId`, `groupId` / `accountId`, `event`, `timestamp`, `properties` / `traits`. Everything
 * else Segment sends is ignored at the edge. Only what aggregation needs is kept in the job
 * (data minimisation, Rule 8): no free-form properties travel past this file.
 */
const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(200);
const when = z.iso.datetime({ offset: true });

const context = z.object({ groupId: id.optional() }).passthrough();

const common = {
  messageId: id.optional(),
  userId: id.optional(),
  groupId: id.optional(),
  accountId: id.optional(),
  timestamp: when.optional(),
  context: context.optional(),
};

const properties = z
  .object({ feature: text.optional(), groupId: id.optional(), accountId: id.optional() })
  .passthrough();

export const trackBody = z.object({
  ...common,
  type: z.literal("track").optional(),
  event: text,
  properties: properties.optional(),
});

export const identifyBody = z.object({
  ...common,
  type: z.literal("identify").optional(),
  traits: z
    .object({ email: z.string().trim().max(320).optional() })
    .passthrough()
    .optional(),
});

/** Segment also sends group and page calls; they carry no usage, so they are counted as ignored. */
const ignoredBody = z.object({ type: z.enum(["group", "page", "screen", "alias"]) }).passthrough();

const batchItem = z.union([
  trackBody.extend({ type: z.literal("track") }),
  identifyBody.extend({ type: z.literal("identify") }),
  ignoredBody,
]);

export const batchBody = z.object({ batch: z.array(z.unknown()).min(1).max(500) });

export interface UsageEvent {
  kind: "track" | "identify";
  userId: string;
  groupRef: string;
  at: string;
  messageId?: string;
  event?: string;
  feature?: string;
  email?: string;
}

export interface Rejected {
  index: number;
  reason: string;
}

/** One body → events the aggregation job understands, or a reason. `now` stamps untimed events. */
export function toUsageEvent(
  raw: unknown,
  forced: "track" | "identify" | undefined,
  now: Date,
): UsageEvent | "ignored" | string {
  const parsed = forced
    ? (forced === "track" ? trackBody : identifyBody).safeParse(raw)
    : batchItem.safeParse(raw);
  if (!parsed.success) {
    const t =
      raw && typeof raw === "object" && "type" in raw
        ? String((raw as { type: unknown }).type)
        : "";
    if (!forced && ["group", "page", "screen", "alias"].includes(t)) return "ignored";
    const issue = parsed.error.issues[0];
    return `${issue?.path.join(".") || "event"}: ${issue?.message ?? "is not valid"}`;
  }
  const d = parsed.data as z.infer<typeof trackBody> &
    z.infer<typeof identifyBody> & { type?: string };
  if (d.type && !["track", "identify"].includes(d.type)) return "ignored";
  const kind = forced ?? (d.type === "identify" ? "identify" : "track");
  const userId = d.userId;
  if (!userId) return "userId: every event needs a userId";
  const groupRef =
    d.groupId ??
    d.accountId ??
    d.context?.groupId ??
    (kind === "track" ? (d.properties?.groupId ?? d.properties?.accountId) : undefined);
  if (!groupRef) return "groupId: every event needs a groupId (or accountId) naming the account";
  const at = d.timestamp ? new Date(d.timestamp) : now;
  return {
    kind,
    userId,
    groupRef,
    at: at.toISOString(),
    messageId: d.messageId,
    event: kind === "track" ? d.event : undefined,
    feature: kind === "track" ? d.properties?.feature : undefined,
    email: kind === "identify" ? d.traits?.email?.toLowerCase() : undefined,
  };
}
