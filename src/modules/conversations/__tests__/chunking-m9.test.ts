import { describe, expect, it } from "vitest";
import { approxTokens, chunkTranscript } from "../chunk";

const header = "Title: Call\nDate: 2026-10-02\nParticipants: Leo Marsh, Elena Voss\n";
const turn = (who: string, n: number) =>
  `${who}: ${"We talked about the reporting setup. ".repeat(n).trim()}`;
const transcript = (turns: string[]) => `${header}\n${turns.join("\n")}\n`;

describe("chunkTranscript (M9 A2)", () => {
  it("a short transcript is one chunk, index 0, whole", () => {
    const t = transcript([turn("Leo Marsh", 2), turn("Elena Voss", 2)]);
    const chunks = chunkTranscript(t, { maxTokens: 8000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.index).toBe(0);
    expect(chunks[0]!.text).toContain("Leo Marsh: We talked");
    expect(chunks[0]!.text).toContain("Elena Voss: We talked");
  });

  it("empty text gives no chunks", () => {
    expect(chunkTranscript("  \n ", { maxTokens: 100 })).toEqual([]);
  });

  it("splits between speaker turns, keeps every chunk within the budget, in order", () => {
    const turns = Array.from({ length: 40 }, (_, i) => turn(i % 2 ? "Elena Voss" : "Leo Marsh", 3));
    const chunks = chunkTranscript(transcript(turns), { maxTokens: 300 });
    expect(chunks.length).toBeGreaterThan(2);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(approxTokens(c.text)).toBeLessThanOrEqual(300);
    });
  });

  it("every chunk repeats the header so a date in the text still has its call date", () => {
    const turns = Array.from({ length: 30 }, () => turn("Leo Marsh", 3));
    for (const c of chunkTranscript(transcript(turns), { maxTokens: 300 }))
      expect(c.text.startsWith("Title: Call\nDate: 2026-10-02")).toBe(true);
  });

  it("loses no turn and duplicates none: the turns across chunks equal the turns in", () => {
    const turns = Array.from(
      { length: 25 },
      (_, i) => `${i % 2 ? "Elena Voss" : "Leo Marsh"}: Line number ${i} about exports.`,
    );
    const chunks = chunkTranscript(transcript(turns), { maxTokens: 200 });
    const out = chunks.flatMap((c) =>
      c.text.split("\n").filter((l) => /: Line number \d+/.test(l)),
    );
    expect(out).toEqual(turns);
  });

  it("a turn longer than the budget is split on sentence ends, never mid-word, and each sentence lands in exactly one chunk", () => {
    const sentences = Array.from(
      { length: 30 },
      (_, i) => `Sentence ${i} is about the export problem.`,
    );
    const t = transcript([`Elena Voss: ${sentences.join(" ")}`]);
    const chunks = chunkTranscript(t, { maxTokens: 120 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const s of sentences) expect(chunks.filter((c) => c.text.includes(s))).toHaveLength(1);
    for (const c of chunks) expect(approxTokens(c.text)).toBeLessThanOrEqual(120);
  });

  it("a continued turn keeps its speaker so who-said-it stays decidable", () => {
    const sentences = Array.from(
      { length: 30 },
      (_, i) => `Sentence ${i} is about the export problem.`,
    );
    const chunks = chunkTranscript(transcript([`Elena Voss: ${sentences.join(" ")}`]), {
      maxTokens: 120,
    });
    for (const c of chunks) {
      const body = c.text.split("\n").filter((l) => l.includes("Sentence"));
      for (const l of body) expect(l.startsWith("Elena Voss: ")).toBe(true);
    }
  });

  it("refuses a budget too small to hold the header and one sentence (never silently drops text)", () => {
    expect(() => chunkTranscript(transcript([turn("Leo Marsh", 1)]), { maxTokens: 5 })).toThrow(
      /budget/i,
    );
  });
});
