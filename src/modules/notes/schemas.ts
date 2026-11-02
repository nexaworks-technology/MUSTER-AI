import { z } from "zod";

export const createNoteInput = z.object({
  accountId: z.string().min(1),
  body: z.string().trim().min(1, "Write something in the note").max(10_000),
  templateId: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  tags: z
    .preprocess(
      (v) => (typeof v === "string" ? v.split(",") : v),
      z
        .array(z.string().trim().toLowerCase().max(40))
        .transform((t) => [...new Set(t.filter(Boolean))].slice(0, 10)),
    )
    .default([]),
});
