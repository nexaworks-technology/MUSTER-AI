/**
 * Upload rules in one place (ARCHITECTURE §7.6, CLAUDE.md M2 rule 4). Every upload is checked
 * against this list by its content, not by the name or the browser's claimed type.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type UploadPurpose = "CONTRACT_DOCUMENT" | "CSV_IMPORT";

export interface AllowedType {
  ext: string;
  label: string;
  /** The MIME type we store and serve. */
  mime: string;
  /** Binary formats are recognised from their magic bytes; text formats must be clean UTF-8. */
  kind: "binary" | "text";
}

export const UPLOAD_TYPES: Record<string, AllowedType> = {
  pdf: { ext: "pdf", label: "PDF", mime: "application/pdf", kind: "binary" },
  docx: {
    ext: "docx",
    label: "Word (.docx)",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    kind: "binary",
  },
  png: { ext: "png", label: "PNG image", mime: "image/png", kind: "binary" },
  jpg: { ext: "jpg", label: "JPEG image", mime: "image/jpeg", kind: "binary" },
  txt: { ext: "txt", label: "Text (.txt)", mime: "text/plain", kind: "text" },
  csv: { ext: "csv", label: "CSV", mime: "text/csv", kind: "text" },
};

export const ALLOWED_BY_PURPOSE: Record<UploadPurpose, readonly string[]> = {
  CONTRACT_DOCUMENT: ["pdf", "docx", "png", "jpg", "txt"],
  CSV_IMPORT: ["csv"],
};
