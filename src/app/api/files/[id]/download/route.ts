import { ForbiddenError } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { FileNotFoundError, FileNotReadyError, readFile } from "@/modules/files/service";

/**
 * GET /api/files/[id]/download — the only download path (no presigned or public URLs).
 * Always an attachment, never rendered inline on our origin.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getWorkspaceContext();
  if (!ctx) return new Response("Sign in to download files.", { status: 401 });
  try {
    const file = await readFile(ctx, id);
    return new Response(Buffer.from(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof FileNotFoundError || error instanceof ForbiddenError)
      return new Response("File not found.", { status: 404 });
    if (error instanceof FileNotReadyError) return new Response(error.message, { status: 409 });
    logger.error({ err: error, fileId: id }, "download failed");
    return new Response("The file could not be downloaded.", { status: 500 });
  }
}
