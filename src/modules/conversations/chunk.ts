/**
 * Splits a call transcript into chunks the Watcher reads one at a time (M9, ≤ ~8k tokens each).
 * Splits only between speaker turns; a single turn longer than the budget is split on sentence
 * ends and every piece keeps its speaker, so "who said it" stays decidable from the chunk alone.
 * Every chunk starts with the transcript's header (title, date, participants) so a relative date
 * in the text keeps its call date. Quotes are verified against the chunk they came from, and since
 * no turn or sentence is ever cut, a verbatim quote is never divided by a boundary.
 */
export interface TextChunk {
  index: number;
  text: string;
}

export const DEFAULT_CHUNK_TOKENS = 8000;

/** A cheap, stable estimate (4 characters per token); chunking never needs the real tokenizer. */
export const approxTokens = (s: string) => Math.ceil(s.length / 4);

const SPEAKER = /^([^:\n]{1,60}):\s+(\S[\s\S]*)$/;

function splitHeader(text: string): { header: string; body: string[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blank = lines.findIndex((l) => l.trim() === "");
  const first = lines[0] ?? "";
  const hasHeader = blank > 0 && /^(title|date|participants):/i.test(first);
  if (!hasHeader) return { header: "", body: lines.filter((l) => l.trim() !== "") };
  return {
    header: lines.slice(0, blank).join("\n"),
    body: lines.slice(blank + 1).filter((l) => l.trim() !== ""),
  };
}

function sentences(s: string): string[] {
  return s.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g)?.map((x) => x.trim()) ?? [s];
}

function splitTurn(turn: string, room: number): string[] {
  const m = SPEAKER.exec(turn);
  const speaker = m ? `${m[1]}: ` : "";
  const body = m ? m[2]! : turn;
  const pieces: string[] = [];
  let cur = "";
  for (const s of sentences(body)) {
    if (approxTokens(speaker + s) > room)
      throw new Error("chunk budget is too small to hold the header and one sentence");
    const next = cur ? `${cur} ${s}` : s;
    if (cur && approxTokens(speaker + next) > room) {
      pieces.push(speaker + cur);
      cur = s;
    } else cur = next;
  }
  if (cur) pieces.push(speaker + cur);
  return pieces;
}

export function chunkTranscript(
  text: string,
  opts: { maxTokens?: number } = {},
): TextChunk[] {
  const max = opts.maxTokens ?? DEFAULT_CHUNK_TOKENS;
  const { header, body } = splitHeader(text);
  if (body.length === 0 && !header) return [];
  const head = header ? `${header}\n\n` : "";
  const room = max - approxTokens(head) - 1;
  if (room < 1) throw new Error("chunk budget is too small to hold the header and one sentence");

  const units = body.flatMap((turn) =>
    approxTokens(turn) > room ? splitTurn(turn, room) : [turn],
  );
  const chunks: string[][] = [];
  let cur: string[] = [];
  let used = 0;
  for (const u of units) {
    const cost = approxTokens(u) + 1;
    if (cur.length && used + cost > room) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(u);
    used += cost;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((turns, index) => ({ index, text: `${head}${turns.join("\n")}` }));
}
