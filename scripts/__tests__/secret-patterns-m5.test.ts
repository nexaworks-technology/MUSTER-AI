import { describe, expect, it } from "vitest";
import { scanText } from "../secret-patterns";

/**
 * M5 acceptance #10 (Rule 9): the secret scan covers the connector credential shapes. Inputs are
 * assembled from pieces so this file never contains a real-looking secret itself. A new file:
 * the pre-M5 scanner test is not edited.
 */
const fake = {
  slackBot: ["xoxb", "1234567890", "abcdefghijklmnop"].join("-"),
  stripeLive: ["rk", "live", "A".repeat(24)].join("_"),
  stripeWebhook: ["whsec", "B".repeat(32)].join("_"),
  hubspot: ["pat", "na1", "1a2b3c4d", "aaaa-bbbb-cccc-dddddddddddd"].join("-"),
  salesforce: "00D5f000000LARK" + "!" + "AQ".repeat(30),
};

describe("secret scanner: M5 connector credentials", () => {
  it.each(Object.entries(fake))("flags %s", (_name, value) => {
    expect(scanText("src/x.ts", `const k = "${value}";`)).toHaveLength(1);
  });

  it("does not flag the fixtures' obviously fake placeholders", () => {
    for (const v of [
      "fixture-slack-bot-token-not-a-secret",
      "fixture-access-token-not-a-secret",
      "fixture-sf-access-not-a-secret",
      "rk_test_fixture",
      "whsec_test_stripe_int_only",
      "test_fixture_cb_key",
    ])
      expect(scanText("src/x.ts", `const k = "${v}";`)).toEqual([]);
  });
});
