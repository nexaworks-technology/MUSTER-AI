# Prompts

Every AI prompt lives here as one versioned Markdown file (CLAUDE.md layout, DECISIONS D-25).
No agents exist yet in M1. The first prompts arrive with the agent framework in M4.

## Format

```markdown
---
name: renewal-manager # kebab-case, must equal the file name
version: 1.0.0 # semver; the agent definition pins this exact version
agent: renewal-manager # the agent key that uses it
tier: standard # fast | standard | deep → AI_MODEL_FAST / _STANDARD / _DEEP
changelog:
  - "1.0.0: first version"
---

Prompt body. Placeholders look like {{accountName}}; rendering fails if one has no value.
```

## Rules

- Model names never appear in prompts or code. A tier maps to an environment variable.
- A prompt is loaded by `loadPrompt(name, version)` from `src/lib/ai`. A version mismatch is an error, so each
  AgentRun can record exactly which prompt produced it (Rule 5).
- Prompts must tell the model to report missing data instead of guessing (Rule 4).
- Changing a prompt's wording means bumping its version, adding a changelog line, and, from M4 on, attaching
  an eval/golden note to the milestone log.
- `__recordings__/` (from M4) holds recorded outputs for tests and demo replay only (`AI_PROVIDER=recorded`,
  refused in production).
