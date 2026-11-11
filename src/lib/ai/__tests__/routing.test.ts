import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listAgents } from "@/modules/agents/service";
import { DEEP_TIER_JOBS, jobTier } from "../routing";

/**
 * FIX: frugal routing (docs/AI-COST-2026-11-11.md). Every AI job runs on the fast tier
 * (claude-haiku-4-5) except the jobs in ONE list. This test pins the whole table, so moving a job
 * to a dearer tier is a deliberate, visible change.
 */
describe("AI model routing", () => {
  it("the deep-tier exceptions are exactly Ask AI answers and the Leader Reporter", () => {
    expect([...DEEP_TIER_JOBS].sort()).toEqual(["ask-ai", "leader-reporter"]);
  });

  it("pins every registered agent's tier", () => {
    const table = Object.fromEntries(listAgents().map((a) => [a.key, a.modelTier]));
    expect(table).toEqual({
      "adoption-coach": "fast",
      "ask-ai": "deep",
      "champion-guard": "fast",
      "digital-csm": "fast",
      "expansion-finder": "fast",
      "health-analyst": "fast",
      "leader-reporter": "deep",
      "meeting-qbr": "fast",
      "onboarding-manager": "fast",
      outreach: "fast",
      "play-builder": "fast",
      "promise-keeper": "fast",
      "renewal-manager": "fast",
      "support-risk": "fast",
      watcher: "fast",
    });
  });

  it("job names that are not agents (Ask AI planning, meeting and QBR prompts) default to fast", () => {
    for (const job of ["ask-ai-plan", "meeting-brief", "meeting-summary", "qbr-narrative", "x"])
      expect(jobTier(job)).toBe("fast");
    expect(jobTier("ask-ai")).toBe("deep");
    expect(jobTier("leader-reporter")).toBe("deep");
  });

  it("every prompt file declares the tier its job routes to", () => {
    const dir = path.join(process.cwd(), "prompts");
    const seen: Record<string, string> = {};
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "README.md")) {
      const tier = /^tier:\s*(\w+)/m.exec(readFileSync(path.join(dir, f), "utf8"))?.[1];
      seen[f.replace(/\.md$/, "")] = tier ?? "MISSING";
    }
    expect(seen).toEqual(
      Object.fromEntries(Object.keys(seen).map((name) => [name, jobTier(name)])),
    );
    // Ask AI's planning step is not an answer: it routes fast. Only final answers and the Leader
    // Reporter are deep.
    expect(Object.keys(seen).filter((n) => seen[n] === "deep").sort()).toEqual([
      "ask-ai",
      "leader-reporter",
    ]);
  });
});
