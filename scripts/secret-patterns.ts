/**
 * Patterns for credential-like strings that must never be committed (Rule 9).
 * Kept separate from the CLI so the scanner can be unit-tested without touching git.
 */
export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
}

const RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { rule: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { rule: "resend-key", pattern: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/ },
  { rule: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { rule: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "stripe-secret", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  // M5 connectors: Stripe webhook secrets, HubSpot private-app tokens, Salesforce session ids.
  { rule: "stripe-webhook-secret", pattern: /\bwhsec_[A-Za-z0-9]{24,}\b/ },
  { rule: "hubspot-token", pattern: /\bpat-(?:na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f-]{20,}/ },
  { rule: "salesforce-session", pattern: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]{40,}/ },
  // M6: the Usage API's ingest key (`nxu_` + 43 URL-safe characters). Only its hash is ever stored.
  { rule: "usage-ingest-key", pattern: /\bnxu_[A-Za-z0-9_-]{40,}/ },
  // Local DB passwords committed as string literals (Q-78; caught the commit 712d626 shape).
  {
    rule: "db-password",
    pattern:
      /\b(?:OWNER|APP|DB|PG|POSTGRES)(?:_[A-Z0-9]+)*_(?:PASS|PASSWORD)\s*[:=]\s*["'\x60](?!\$)[^"'\x60\n]{4,}["'\x60]/i,
  },
  {
    rule: "url-credentials",
    // A template interpolation (`${APP_PASS}@`) is code, not a credential (M12 A2).
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?!\$\{)[^\s@/]{6,}@(?!localhost|127\.0\.0\.1)/i,
  },
  // M12 A2: a hard-coded fallback after `??` to a quoted literal naming a secret (the shape of the removed M10 survey
  // default). A `$`-placeholder or another env var is not a finding.
  {
    rule: "secret-fallback-default",
    pattern: /\?\?\s*["'\x60](?!\$)[^"'\x60\n]*secret[^"'\x60\n]*["'\x60]/i,
  },
];

/** `.env.example` may hold names only: every non-comment line is `NAME=` with nothing after. */
export function checkEnvExample(file: string, content: string): SecretFinding[] {
  return content.split("\n").flatMap((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || /^[A-Z][A-Z0-9_]*=$/.test(line)) return [];
    return [{ file, line: i + 1, rule: "env-example-has-value" }];
  });
}

export function scanText(file: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  content.split("\n").forEach((text, i) => {
    for (const { rule, pattern } of RULES) {
      if (pattern.test(text)) findings.push({ file, line: i + 1, rule });
    }
  });
  if (file.endsWith(".env.example")) findings.push(...checkEnvExample(file, content));
  return findings;
}
