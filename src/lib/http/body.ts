/**
 * Streaming request-body cap (M12 A9). Reads the body chunk by chunk and stops as soon as it
 * passes `maxBytes` — a chunked request with no (or a false) Content-Length cannot make the
 * server buffer more than the cap. A declared Content-Length over the cap is refused at once.
 */
export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export async function readCapped(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError(maxBytes);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function readCappedText(req: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readCapped(req, maxBytes));
}

/** Multipart/form bodies: capped read first, then parsed from the bytes already in memory. */
export async function readCappedForm(req: Request, maxBytes: number): Promise<FormData> {
  const bytes = await readCapped(req, maxBytes);
  return new Response(bytes as unknown as BodyInit, {
    headers: { "content-type": req.headers.get("content-type") ?? "" },
  }).formData();
}

export const tooLarge = () => new Response("too large", { status: 413 });
