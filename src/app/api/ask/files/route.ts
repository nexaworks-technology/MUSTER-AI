import { z } from "zod";
import { openUpload } from "@/lib/http/guard";
import { MAX_UPLOAD_BYTES } from "@/config/uploads";
import { ForbiddenError } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { requestLogger } from "@/lib/logger/request";
import { attachFile } from "@/modules/ask-ai/service";
import { FileNotFoundError, UploadRejectedError } from "@/modules/files/service";

/**
 * POST /api/ask/files — attach a file to an Ask AI conversation (purpose ASK_ATTACHMENT).
 * Multipart fields: file, threadId?. Type, size and content checks and the malware scan run in the
 * files service; the file is readable only by the member who attached it.
 */
const fields = z.object({ threadId: z.string().min(1).max(64).optional() });
const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const ctx = await getWorkspaceContext();
  // M12 A9: 401s counted per IP, a per-member limit, and a streaming cap on the body.
  const open = await openUpload(req, ctx, MAX_UPLOAD_BYTES + 64 * 1024, () =>
    json({ error: "Sign in to attach files." }, 401),
  );
  if (open.refused) return open.refused;
  if (!ctx) return json({ error: "Sign in to attach files." }, 401);
  const form = open.form;
  const file = form.get("file");
  const parsed = fields.safeParse({ threadId: form.get("threadId") || undefined });
  if (!parsed.success || !(file instanceof File))
    return json({ error: "Choose a file to attach." }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return json({ error: "Files can be up to 25 MB." }, 413);
  try {
    const res = await attachFile(ctx, {
      threadId: parsed.data.threadId,
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return json(res, 201);
  } catch (error) {
    if (error instanceof UploadRejectedError) return json({ error: error.message }, 400);
    if (error instanceof ForbiddenError)
      return json({ error: "You don't have permission to do that." }, 403);
    if (error instanceof FileNotFoundError)
      return json({ error: "That conversation was not found." }, 404);
    (await requestLogger()).error({ err: error }, "ask attachment failed");
    return json({ error: "The upload failed. Nothing was saved." }, 500);
  }
}
