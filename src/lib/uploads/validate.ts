import { fileTypeFromBuffer } from "file-type";
import {
  ALLOWED_BY_PURPOSE,
  MAX_UPLOAD_BYTES,
  UPLOAD_TYPES,
  type UploadPurpose,
} from "@/config/uploads";

/**
 * Upload checks (ARCHITECTURE §7.6): size, extension allowed for the purpose, and content that
 * really is that type — magic bytes for binary formats, clean UTF-8 without control bytes for
 * text. The browser's claimed MIME type is ignored. A failure never reaches storage.
 */
export type UploadCheck =
  { ok: true; ext: string; mime: string; safeName: string } | { ok: false; error: string };

const EXT_ALIASES: Record<string, string> = { jpeg: "jpg" };

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9 ._()-]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!cleaned) return "file";
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 120 - ext.length) + ext;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return EXT_ALIASES[ext] ?? ext;
}

const accepted = (purpose: UploadPurpose) =>
  ALLOWED_BY_PURPOSE[purpose].map((e) => UPLOAD_TYPES[e]!.label).join(", ");

export async function validateUpload(input: {
  filename: string;
  bytes: Uint8Array;
  purpose: UploadPurpose;
}): Promise<UploadCheck> {
  const safeName = sanitizeFilename(input.filename);
  if (input.bytes.byteLength === 0) return { ok: false, error: "The file is empty." };
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `Files can be up to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
    };
  }
  const ext = extensionOf(safeName);
  const type = UPLOAD_TYPES[ext];
  if (!type || !ALLOWED_BY_PURPOSE[input.purpose].includes(ext)) {
    return {
      ok: false,
      error: `That type of file isn't accepted here. Accepted: ${accepted(input.purpose)}.`,
    };
  }
  const detected = await fileTypeFromBuffer(input.bytes);
  if (type.kind === "binary") {
    const matches = detected && (EXT_ALIASES[detected.ext] ?? detected.ext) === ext;
    if (!matches)
      return {
        ok: false,
        error: `This file doesn't look like a ${type.label}, so it wasn't uploaded.`,
      };
  } else {
    if (detected && (EXT_ALIASES[detected.ext] ?? detected.ext) !== ext)
      return {
        ok: false,
        error: `This file is not a plain-text ${type.label}, so it wasn't uploaded.`,
      };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch {
      return { ok: false, error: `The ${type.label} must be saved as UTF-8 text.` };
    }
    if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) {
      return {
        ok: false,
        error: `This file is not a plain-text ${type.label}, so it wasn't uploaded.`,
      };
    }
    if (ext === "vtt") {
      const trimmed = text.replace(/^\uFEFF/, "").trimStart();
      if (!trimmed.startsWith("WEBVTT")) {
        return { ok: false, error: "A WebVTT file must begin with 'WEBVTT'." };
      }
    } else if (ext === "srt") {
      if (!text.includes("-->")) {
        return { ok: false, error: "A SubRip (.srt) file must contain timestamp arrows (-->)." };
      }
    } else if (ext === "json") {
      try {
        JSON.parse(text);
      } catch {
        return { ok: false, error: "The file is not valid JSON." };
      }
    }
  }
  return { ok: true, ext, mime: type.mime, safeName };
}
