import { z } from "zod";
import { MAX_UPLOAD_BYTES } from "@/config/uploads";
import { ForbiddenError } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { FileNotFoundError, storeUpload, UploadRejectedError } from "@/modules/files/service";

/**
 * POST /api/files — the only upload path (ARCHITECTURE §7.6). Multipart fields: purpose,
 * accountId?, contractId?, file. Membership, permission and content checks run server-side.
 */
const fields = z.object({
  purpose: z.enum(["CONTRACT_DOCUMENT", "CSV_IMPORT"]),
  accountId: z.string().min(1).optional(),
  contractId: z.string().min(1).optional(),
});

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const ctx = await getWorkspaceContext();
  if (!ctx) return json({ error: "Sign in to upload files." }, 401);
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES + 64 * 1024)
    return json({ error: "Files can be up to 25 MB." }, 413);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "The upload could not be read. Try again." }, 400);
  }
  const file = form.get("file");
  const parsed = fields.safeParse({
    purpose: form.get("purpose"),
    accountId: form.get("accountId") || undefined,
    contractId: form.get("contractId") || undefined,
  });
  if (!parsed.success || !(file instanceof File))
    return json({ error: "Choose a file to upload." }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return json({ error: "Files can be up to 25 MB." }, 413);
  try {
    const stored = await storeUpload(ctx, {
      ...parsed.data,
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return json({ id: stored.id, filename: stored.filename }, 201);
  } catch (error) {
    if (error instanceof UploadRejectedError) return json({ error: error.message }, 400);
    if (error instanceof ForbiddenError)
      return json({ error: "You don't have permission to upload this." }, 403);
    if (
      error instanceof FileNotFoundError ||
      (error instanceof Error && error.name === "AccountNotFoundError")
    ) {
      return json({ error: "That account or contract was not found." }, 404);
    }
    logger.error({ err: error }, "upload failed");
    return json({ error: "The upload failed. Nothing was saved." }, 500);
  }
}
