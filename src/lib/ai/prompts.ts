import { readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";

/**
 * Versioned prompt files (CLAUDE.md layout, DECISIONS D-25): `prompts/<name>.md` with YAML
 * frontmatter. Agents pin `{ name, version }`; a mismatch fails at load, so every AgentRun can
 * record exactly which prompt produced it.
 */
export const promptFrontmatter = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "name must be kebab-case"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver, e.g. 1.0.0"),
  agent: z.string().min(1),
  tier: z.enum(["fast", "standard", "deep"]),
  changelog: z.array(z.string().min(1)).min(1, "changelog needs at least one entry"),
});

export type PromptFile = z.infer<typeof promptFrontmatter> & { body: string; ref: string };

export const PROMPTS_DIR = path.join(process.cwd(), "prompts");

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

export function parsePrompt(fileName: string, source: string): PromptFile {
  const { data, content } = matter(source);
  const parsed = promptFrontmatter.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "frontmatter"}: ${i.message}`)
      .join("; ");
    throw new PromptError(`${fileName}: invalid frontmatter (${issues})`);
  }
  if (`${parsed.data.name}.md` !== path.basename(fileName)) {
    throw new PromptError(
      `${fileName}: frontmatter name "${parsed.data.name}" must match the file name`,
    );
  }
  const body = content.trim();
  if (!body) throw new PromptError(`${fileName}: prompt body is empty`);
  return { ...parsed.data, body, ref: `${parsed.data.name}@${parsed.data.version}` };
}

export async function loadPrompt(
  name: string,
  expectedVersion: string,
  dir = PROMPTS_DIR,
): Promise<PromptFile> {
  const file = path.join(dir, `${name}.md`);
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    throw new PromptError(
      `prompt "${name}" not found in ${path.relative(process.cwd(), dir) || dir}`,
    );
  }
  const prompt = parsePrompt(file, source);
  if (prompt.version !== expectedVersion) {
    throw new PromptError(
      `prompt "${name}" is version ${prompt.version}; the agent expects ${expectedVersion}`,
    );
  }
  return prompt;
}

/** Replaces `{{key}}` placeholders; a placeholder without a value is an error, never left blank. */
export function renderPrompt(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new PromptError(`missing value for {{${key}}}`);
    return value;
  });
}
