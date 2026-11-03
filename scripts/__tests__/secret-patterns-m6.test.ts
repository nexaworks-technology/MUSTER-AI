import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newIngestKey } from "@/modules/integrations/service";
import { scanText } from "../secret-patterns";

/**
 * M6 secret pass (Rule 9): the Usage API's ingest key shape is caught wherever it is committed,
 * and every new fixture (usage events, Mixpanel, Amplitude) holds only fictional, obviously fake
 * values: the fixtures' "rejected" credentials are names, not secrets.
 */
const root = process.cwd();
const jsonUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? jsonUnder(path.join(dir, d.name))
      : d.name.endsWith(".json")
        ? [path.join(dir, d.name)]
        : [],
  );

describe("M6 secret patterns", () => {
  it("flags a real ingest key shape, and not its prefix or the demo placeholder", () => {
    const key = newIngestKey();
    expect(scanText("notes.md", `Authorization: Bearer ${key}`)).toEqual([
      { file: "notes.md", line: 1, rule: "usage-ingest-key" },
    ]);
    expect(scanText("docs.md", "keys start with nxu_ and are shown once")).toEqual([]);
    expect(scanText("docs.md", "Authorization: Bearer <key>")).toEqual([]);
  });

  it("finds no secret in the new fixtures", () => {
    const files = [
      ...jsonUnder(path.join(root, "fixtures", "usage")),
      ...jsonUnder(path.join(root, "src/modules/integrations/adapters/mixpanel/__fixtures__")),
      ...jsonUnder(path.join(root, "src/modules/integrations/adapters/amplitude/__fixtures__")),
      ...jsonUnder(path.join(root, "prompts/__golden__/onboarding-manager")),
      ...jsonUnder(path.join(root, "prompts/__golden__/adoption-coach")),
    ];
    expect(files.length).toBeGreaterThan(15);
    for (const f of files) expect(scanText(f, readFileSync(f, "utf8"))).toEqual([]);
  });
});
