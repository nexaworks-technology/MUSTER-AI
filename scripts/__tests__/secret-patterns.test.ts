import { describe, expect, it } from "vitest";
import { checkEnvExample, scanText } from "../secret-patterns";

// Test inputs are assembled from pieces so this file never contains a real-looking secret itself.
const fake = {
  anthropic: ["sk", "ant", "api03", "A".repeat(30)].join("-"),
  aws: "AKIA" + "ABCDEFGHIJKLMNOP",
  pem: ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
  dbUrl: "postgresql://admin:" + "hunter22secret" + "@db.example.test:5432/app",
};

describe("secret scanner", () => {
  it.each(Object.entries(fake))("flags %s", (_name, value) => {
    expect(scanText("src/x.ts", `const k = "${value}";`)).toHaveLength(1);
  });

  it("reports location and rule, never the matched text", () => {
    const [finding] = scanText("src/x.ts", `\nconst k = "${fake.anthropic}";`);
    expect(finding).toEqual({ file: "src/x.ts", line: 2, rule: "anthropic-key" });
    expect(JSON.stringify(finding)).not.toContain(fake.anthropic);
  });

  it("allows local development URLs without real credentials", () => {
    expect(
      scanText("docker-compose.yml", "postgresql://app_user:app_user@localhost:5432/x"),
    ).toEqual([]);
  });

  it("accepts an env example with names only", () => {
    expect(checkEnvExample(".env.example", "# comment\nDATABASE_URL=\nAUTH_SECRET=\n")).toEqual([]);
  });

  it("rejects an env example that carries a value", () => {
    expect(checkEnvExample(".env.example", "AUTH_SECRET=abc\n")).toEqual([
      { file: ".env.example", line: 1, rule: "env-example-has-value" },
    ]);
  });
});
