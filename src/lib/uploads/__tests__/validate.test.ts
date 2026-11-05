import { describe, expect, it } from "vitest";
import { sanitizeFilename, validateUpload } from "../validate";

const pdf = Buffer.from("%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj\n<<>>\nendobj\n", "latin1");
const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001",
  "hex",
);
const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 0x90)]);
const csv = Buffer.from("name,domain\nAcme,acme.test\n");

describe("filename sanitising", () => {
  it("drops any path and unsafe characters", () => {
    expect(sanitizeFilename("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(sanitizeFilename("C:\\Users\\me\\Contract (signed).pdf")).toBe("Contract (signed).pdf");
    expect(sanitizeFilename("re\u0000port<script>.csv")).toBe("report_script_.csv");
    expect(sanitizeFilename("   ")).toBe("file");
    expect(sanitizeFilename(`${"a".repeat(300)}.pdf`)).toMatch(/^a{100,}\.pdf$/);
    expect(sanitizeFilename(`${"a".repeat(300)}.pdf`).length).toBeLessThanOrEqual(120);
  });
});

describe("upload validation (content-based)", () => {
  it("accepts a real PDF as a contract document", async () => {
    expect(
      await validateUpload({ filename: "contract.pdf", bytes: pdf, purpose: "CONTRACT_DOCUMENT" }),
    ).toEqual({
      ok: true,
      ext: "pdf",
      mime: "application/pdf",
      safeName: "contract.pdf",
    });
  });

  it("rejects an empty file and a file over the size limit", async () => {
    expect(
      await validateUpload({
        filename: "x.pdf",
        bytes: Buffer.alloc(0),
        purpose: "CONTRACT_DOCUMENT",
      }),
    ).toMatchObject({ ok: false, error: /empty/ });
    expect(
      await validateUpload({
        filename: "x.pdf",
        bytes: Buffer.alloc(26 * 1024 * 1024),
        purpose: "CONTRACT_DOCUMENT",
      }),
    ).toMatchObject({ ok: false, error: /up to 25 MB/ });
  });

  it("rejects types not allowed for the purpose, naming what is accepted", async () => {
    expect(
      await validateUpload({ filename: "contract.pdf", bytes: pdf, purpose: "CSV_IMPORT" }),
    ).toMatchObject({ ok: false, error: /Accepted: CSV/ });
    expect(
      await validateUpload({ filename: "tool.exe", bytes: exe, purpose: "CONTRACT_DOCUMENT" }),
    ).toMatchObject({ ok: false });
  });

  it("rejects a file whose content does not match its name", async () => {
    expect(
      await validateUpload({ filename: "invoice.pdf", bytes: exe, purpose: "CONTRACT_DOCUMENT" }),
    ).toMatchObject({ ok: false, error: /doesn't look like a PDF/ });
    expect(
      await validateUpload({ filename: "data.csv", bytes: pdf, purpose: "CSV_IMPORT" }),
    ).toMatchObject({ ok: false, error: /not a plain-text CSV/ });
    expect(
      await validateUpload({ filename: "scan.pdf", bytes: png, purpose: "CONTRACT_DOCUMENT" }),
    ).toMatchObject({ ok: false });
  });

  it("rejects text files with binary content or invalid UTF-8", async () => {
    expect(
      await validateUpload({
        filename: "a.csv",
        bytes: Buffer.from("a,b\n\u0000\u0001,2\n"),
        purpose: "CSV_IMPORT",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await validateUpload({
        filename: "a.csv",
        bytes: Buffer.from([0x61, 0x2c, 0xff, 0xfe, 0x0a]),
        purpose: "CSV_IMPORT",
      }),
    ).toMatchObject({ ok: false, error: /UTF-8/ });
  });

  it("accepts a clean UTF-8 CSV (with or without a byte-order mark)", async () => {
    expect(
      await validateUpload({ filename: "accounts.csv", bytes: csv, purpose: "CSV_IMPORT" }),
    ).toMatchObject({ ok: true, mime: "text/csv" });
    expect(
      await validateUpload({
        filename: "accounts.csv",
        bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv]),
        purpose: "CSV_IMPORT",
      }),
    ).toMatchObject({ ok: true });
  });

  it("treats .jpeg as .jpg", async () => {
    const jpg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffdb", "hex");
    expect(
      await validateUpload({ filename: "photo.JPEG", bytes: jpg, purpose: "CONTRACT_DOCUMENT" }),
    ).toMatchObject({ ok: true, ext: "jpg" });
  });

  describe("CALL_TRANSCRIPT upload validation", () => {
    it("accepts a valid WebVTT file", async () => {
      const vtt = Buffer.from("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello world\n");
      expect(
        await validateUpload({ filename: "meeting.vtt", bytes: vtt, purpose: "CALL_TRANSCRIPT" }),
      ).toMatchObject({ ok: true, ext: "vtt", mime: "text/vtt" });
    });

    it("rejects a .vtt file that does not start with WEBVTT", async () => {
      const badVtt = Buffer.from("1\n00:00:01 --> 00:00:04\nNot vtt\n");
      expect(
        await validateUpload({ filename: "meeting.vtt", bytes: badVtt, purpose: "CALL_TRANSCRIPT" }),
      ).toMatchObject({ ok: false, error: /must begin with 'WEBVTT'/ });
    });

    it("accepts a valid SubRip (.srt) file", async () => {
      const srt = Buffer.from("1\n00:00:01,000 --> 00:00:04,000\nHello from SRT\n");
      expect(
        await validateUpload({ filename: "call.srt", bytes: srt, purpose: "CALL_TRANSCRIPT" }),
      ).toMatchObject({ ok: true, ext: "srt" });
    });

    it("rejects a .srt file without timestamp arrows", async () => {
      const badSrt = Buffer.from("Hello just plain text without timestamps\n");
      expect(
        await validateUpload({ filename: "call.srt", bytes: badSrt, purpose: "CALL_TRANSCRIPT" }),
      ).toMatchObject({ ok: false, error: /timestamp arrows/ });
    });

    it("accepts valid JSON transcript", async () => {
      const json = Buffer.from(JSON.stringify({ segments: [{ text: "Hello" }] }));
      expect(
        await validateUpload({ filename: "transcript.json", bytes: json, purpose: "CALL_TRANSCRIPT" }),
      ).toMatchObject({ ok: true, ext: "json", mime: "application/json" });
    });

    it("rejects invalid JSON", async () => {
      const badJson = Buffer.from("{ invalid json content");
      expect(
        await validateUpload({ filename: "transcript.json", bytes: badJson, purpose: "CALL_TRANSCRIPT" }),
      ).toMatchObject({ ok: false, error: /not valid JSON/ });
    });

    it("accepts plain text transcript (.txt)", async () => {
      const txt = Buffer.from("Speaker 1: Thanks for joining today.\nSpeaker 2: Happy to be here.");
      expect(
        await validateUpload({ filename: "notes.txt", bytes: txt, purpose: "CALL_TRANSCRIPT" }),
      ).toMatchObject({ ok: true, ext: "txt", mime: "text/plain" });
    });

    it("rejects disallowed types (e.g. PDF or binary) for CALL_TRANSCRIPT", async () => {
      expect(
        await validateUpload({ filename: "contract.pdf", bytes: pdf, purpose: "CALL_TRANSCRIPT" }),
      ).toMatchObject({ ok: false, error: /Accepted: WebVTT/ });
    });
  });
});
