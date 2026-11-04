import { z } from "zod";

export const PRIORITY_LABELS = { LOW: "Low", NORMAL: "Normal", HIGH: "High" } as const;

const optionalText = z.preprocess(
  (v) => (v === "" || v == null ? undefined : v),
  z.string().trim().max(2000).optional(),
);

export const createTaskInput = z.object({
  accountId: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  signalId: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  title: z.string().trim().min(1, "Give the task a title").max(200),
  detail: optionalText,
  ownerMembershipId: z.string().min(1, "Choose who owns the task"),
  dueAt: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.date({ message: "Use a valid due date" }).optional(),
  ),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL"),
});

export const taskIdInput = z.object({ taskId: z.string().min(1) });
