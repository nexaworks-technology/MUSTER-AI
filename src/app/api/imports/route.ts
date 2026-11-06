import { z } from "zod";
import { openUpload } from "@/lib/http/guard";
import { MAX_UPLOAD_BYTES } from "@/config/uploads";
import { ForbiddenError } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import {
  ImportError,
  startImport,
  TEMPLATES,
  UploadRejectedError,
} from "@/modules/imports/service";

/** POST /api/imports — upload a CSV for an import (multipart: kind, file). Nothing imports yet. */
const kinds = Object.keys(TEMPLATES) as [string, ...string[]];
const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const ctx = await getWorkspaceContext();
  // M12 A9: 401s counted per IP, a per-member limit, and a streaming cap on the body.
  const open = await openUpload(req, ctx, MAX_UPLOAD_BYTES + 64 * 1024, () =>
    json({ error: "Sign in to import data." }, 401),
  );
  if (open.refused) return open.refused;
  if (!ctx) return json({ error: "Sign in to import data." }, 401);
  const form: FormData | null = open.form;
  const file = form?.get("file");
  const kind = z.enum(kinds).safeParse(form?.get("kind"));
  if (!kind.success || !(file instanceof File))
    return json({ error: "Choose what you're importing and a CSV file." }, 400);
  try {
    const job = await startImport(ctx, kind.data as keyof typeof TEMPLATES, {
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return json({ id: job.id }, 201);
  } catch (error) {
    if (error instanceof ImportError || error instanceof UploadRejectedError)
      return json({ error: error.message }, 400);
    if (error instanceof ForbiddenError)
      return json({ error: "Only admins and CS leaders can import data." }, 403);
    logger.error({ err: error }, "import upload failed");
    return json({ error: "The upload failed. Nothing was imported." }, 500);
  }
}
