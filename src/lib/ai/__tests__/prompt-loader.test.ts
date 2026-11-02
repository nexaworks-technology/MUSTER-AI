import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPrompt, parsePrompt, PromptError, renderPrompt } from "../prompts";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "prompts");
const valid = (fm: string) => `---\n${fm}\n---\nDo the job.\n`;
const FM = "name: x-agent\nversion: 1.0.0\nagent: x\ntier: standard\nchangelog:\n  - first";

describe("prompt loader", () => {
  it("loads a prompt with valid frontmatter at the pinned version", async () => {
    const prompt = await loadPrompt("example-agent", "1.2.0", FIXTURES);
    expect(prompt).toMatchObject({
      name: "example-agent",
      version: "1.2.0",
      tier: "fast",
      ref: "example-agent@1.2.0",
    });
    expect(prompt.body).toContain("{{accountName}}");
  });

  it("fails when the agent pins a different version", async () => {
    await expect(loadPrompt("example-agent", "1.3.0", FIXTURES)).rejects.toThrow(
      /version 1.2.0; the agent expects 1.3.0/,
    );
  });

  it("fails when the prompt file is missing", async () => {
    await expect(loadPrompt("nope", "1.0.0", FIXTURES)).rejects.toBeInstanceOf(PromptError);
  });

  it("fails without frontmatter", () => {
    expect(() => parsePrompt("x-agent.md", "Just text")).toThrow(/invalid frontmatter/);
  });

  it("fails on a non-semver version", () => {
    expect(() => parsePrompt("x-agent.md", valid(FM.replace("1.0.0", "v1")))).toThrow(/semver/);
  });

  it("fails when the name does not match the file", () => {
    expect(() => parsePrompt("other.md", valid(FM))).toThrow(/must match the file name/);
  });

  it("fails on an unknown tier", () => {
    expect(() => parsePrompt("x-agent.md", valid(FM.replace("standard", "huge")))).toThrow(/tier/);
  });

  it("renders placeholders and refuses to leave one blank", () => {
    expect(renderPrompt("Hi {{name}}", { name: "Maya" })).toBe("Hi Maya");
    expect(() => renderPrompt("Hi {{name}}", {})).toThrow(/missing value for \{\{name\}\}/);
  });
});
