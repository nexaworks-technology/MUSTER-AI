import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeSource, SOURCE_TYPES } from "../sources";

/**
 * M3 rule 2: "a Why view that cannot resolve a reason to its source record is a failed slice".
 * Every sourceType the engine can emit must have a link to the record or window it names.
 */
const ENGINE = path.join(import.meta.dirname, "../engine/components");
const emitted = new Set(
  readdirSync(ENGINE)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => [
      ...readFileSync(path.join(ENGINE, f), "utf8").matchAll(/sourceType: "(\w+)"/g),
    ])
    .map((m) => m[1]!),
);

describe("health reason sources", () => {
  it("covers every source type the engine emits", () => {
    expect(emitted.size).toBeGreaterThan(5);
    for (const t of emitted) expect(SOURCE_TYPES, t).toContain(t);
  });

  const a = "acc1";
  const look = {
    usageDate: new Map([["u1", "2026-10-20"]]),
    roleContact: new Map([["r1", { contactId: "c1", role: "CHAMPION", name: "Maya Ortiz" }]]),
    names: new Map([
      ["c1", "Maya Ortiz"],
      ["i1", "INV-1"],
      ["t1", "Export fails"],
    ]),
    // m2 is a reply on a ticket: ticket threads live on the Tickets tab, not Conversations.
    messageTicket: new Map([["m2", { ticketId: "t1", subject: "Export fails" }]]),
    existing: new Set(["u1", "r1", "c1", "i1", "t1", "k1", "e1", "m1", "m2", "p1", "s1"]),
  };

  it.each([
    [
      { sourceType: "SurveyResponse", sourceId: "s1" },
      "Survey response",
      "/accounts/acc1/people",
    ],
    [
      { sourceType: "UsageDaily", accountId: a, from: "2026-10-26", to: "2026-11-01" },
      "Usage, Oct 26 – Nov 1, 2026",
      "/accounts/acc1/usage?from=2026-10-26&to=2026-11-01#usage-chart",
    ],
    [
      { sourceType: "UsageDaily", sourceId: "u1" },
      "Usage on Oct 20, 2026",
      "/accounts/acc1/usage?from=2026-10-20&to=2026-10-20#usage-chart",
    ],
    [
      { sourceType: "UserUsageDaily", accountId: a, from: "2026-08-04", to: "2026-11-01" },
      "People's usage, Aug 4 – Nov 1, 2026",
      "/accounts/acc1/usage?from=2026-08-04&to=2026-11-01#top-users",
    ],
    [
      { sourceType: "FeatureUsageDaily", accountId: a, from: "2026-10-05", to: "2026-11-01" },
      "Feature usage, Oct 5 – Nov 1, 2026",
      "/accounts/acc1/usage?from=2026-10-05&to=2026-11-01#features",
    ],
    [{ sourceType: "Contract", sourceId: "k1" }, "Contract", "/accounts/acc1/billing#contract-k1"],
    [
      { sourceType: "Invoice", sourceId: "i1" },
      "Invoice INV-1",
      "/accounts/acc1/billing#invoice-i1",
    ],
    [
      { sourceType: "Invoice", accountId: a, from: "2026-08-05", to: "2026-11-02" },
      "Invoices, Aug 5 – Nov 2, 2026",
      "/accounts/acc1/billing#invoices",
    ],
    [
      { sourceType: "RevenueEvent", sourceId: "e1" },
      "ARR change",
      "/accounts/acc1/billing#revenue-e1",
    ],
    [
      { sourceType: "RevenueEvent", accountId: a, from: "2025-11-03", to: "2026-11-02" },
      "ARR changes, Nov 3, 2025 – Nov 2, 2026",
      "/accounts/acc1/billing#revenue",
    ],
    [
      { sourceType: "Ticket", sourceId: "t1" },
      "Ticket: Export fails",
      "/accounts/acc1/tickets#ticket-t1",
    ],
    [
      { sourceType: "Ticket", accountId: a, from: "2026-08-05", to: "2026-11-02" },
      "Tickets, Aug 5 – Nov 2, 2026",
      "/accounts/acc1/tickets",
    ],
    [
      { sourceType: "Message", sourceId: "m1" },
      "Message",
      "/accounts/acc1/conversations?message=m1#message-m1",
    ],
    [
      { sourceType: "Message", sourceId: "m2" },
      "Ticket message: Export fails",
      "/accounts/acc1/tickets#ticket-t1",
    ],
    [
      { sourceType: "Message", accountId: a, from: "2026-07-22", to: "2026-10-19" },
      "Emails, Jul 22 – Oct 19, 2026",
      "/accounts/acc1/conversations",
    ],
    [
      { sourceType: "Contact", sourceId: "c1" },
      "Contact: Maya Ortiz",
      "/accounts/acc1/people#contact-c1",
    ],
    [
      { sourceType: "StakeholderRole", sourceId: "r1" },
      "Champion role: Maya Ortiz",
      "/accounts/acc1/people#contact-c1",
    ],
    [{ sourceType: "CsmPulse", sourceId: "p1" }, "CSM Pulse", "/accounts/acc1/health#pulse"],
  ])("%o → %s", (ref, label, href) => {
    expect(describeSource(a, ref, look)).toEqual({ label, href, missing: false });
  });

  it("says plainly when a record no longer exists, instead of a dead link", () => {
    expect(describeSource(a, { sourceType: "Ticket", sourceId: "gone" }, look)).toEqual({
      label: "Ticket (no longer on record)",
      href: null,
      missing: true,
    });
  });
});
