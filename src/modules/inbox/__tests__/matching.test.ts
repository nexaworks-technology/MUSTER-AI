import { describe, expect, it } from "vitest";
import { FREE_MAIL_DOMAINS, matchSender, normalizeDomain, senderDomain } from "../matching";

/**
 * Inbound mail finds its account by contact email first, then by domain; anything ambiguous or
 * unknown is UNMATCHED and never auto-assigned (M9 §2, acceptance #8).
 */
const contacts = [
  { id: "c1", email: "dora@halden.test", accountId: "halden" },
  { id: "c2", email: "sam@northgate.test", accountId: "northgate" },
  { id: "c3", email: "shared@gmail.com", accountId: "tidewater" },
];
const accounts = [
  { id: "halden", domain: "halden.test" },
  { id: "northgate", domain: "northgate.test" },
  { id: "twin1", domain: "twin.test" },
  { id: "twin2", domain: "https://www.twin.test/" },
  { id: "tidewater", domain: "tidewater.test" },
];
const run = (from: string, over: Partial<Parameters<typeof matchSender>[0]> = {}) =>
  matchSender({ from, contacts, accounts, ...over });

describe("matchSender", () => {
  it("an exact contact email wins", () => {
    expect(run("dora@halden.test")).toEqual({
      kind: "MATCHED",
      accountId: "halden",
      contactId: "c1",
      matchedBy: "CONTACT_EMAIL",
    });
  });
  it("ignores case, display names and angle brackets", () => {
    expect(run('"Dora L" <DORA@Halden.Test>')).toMatchObject({
      kind: "MATCHED",
      accountId: "halden",
      matchedBy: "CONTACT_EMAIL",
    });
  });
  it("a domain used by exactly one account matches by domain, with no contact", () => {
    expect(run("someone.new@halden.test")).toEqual({
      kind: "MATCHED",
      accountId: "halden",
      contactId: null,
      matchedBy: "DOMAIN",
    });
  });
  it("a domain shared by two accounts is UNMATCHED and names both candidates", () => {
    const r = run("x@twin.test");
    expect(r).toMatchObject({ kind: "UNMATCHED" });
    if (r.kind === "UNMATCHED") {
      expect(r.candidateAccountIds.sort()).toEqual(["twin1", "twin2"]);
      expect(r.reason).toMatch(/2 accounts share twin\.test/);
    }
  });
  it("a free-mail domain never matches by domain", () => {
    expect(run("someone@gmail.com")).toMatchObject({ kind: "UNMATCHED" });
    expect(
      run("someone@outlook.com", { accounts: [...accounts, { id: "x", domain: "outlook.com" }] }),
    ).toMatchObject({ kind: "UNMATCHED" });
  });
  it("a free-mail address that IS a known contact's email still matches exactly", () => {
    expect(run("shared@gmail.com")).toMatchObject({
      kind: "MATCHED",
      accountId: "tidewater",
      matchedBy: "CONTACT_EMAIL",
    });
  });
  it("the same email on contacts of two accounts is ambiguous, not a guess", () => {
    const r = run("dora@halden.test", {
      contacts: [...contacts, { id: "c9", email: "dora@halden.test", accountId: "northgate" }],
    });
    expect(r).toMatchObject({ kind: "UNMATCHED" });
    if (r.kind === "UNMATCHED")
      expect(r.candidateAccountIds.sort()).toEqual(["halden", "northgate"]);
  });
  it("an unknown domain is UNMATCHED with a plain reason", () => {
    const r = run("who@nobody.test");
    expect(r).toMatchObject({ kind: "UNMATCHED", candidateAccountIds: [] });
    if (r.kind === "UNMATCHED") expect(r.reason).toMatch(/nobody\.test/);
  });
  it("a subdomain is not guessed to belong to the parent domain", () => {
    expect(run("noreply@mail.halden.test")).toMatchObject({ kind: "UNMATCHED" });
  });
  it("an address with no @ is UNMATCHED", () => {
    expect(run("not-an-email")).toMatchObject({ kind: "UNMATCHED" });
  });
});

describe("helpers", () => {
  it("normalizeDomain strips scheme, www, path and case", () => {
    expect(normalizeDomain("https://WWW.Twin.test/about")).toBe("twin.test");
    expect(normalizeDomain(null)).toBeNull();
  });
  it("senderDomain reads the part after the last @", () => {
    expect(senderDomain("A <a@B.test>")).toBe("b.test");
  });
  it("the free-mail list has the usual suspects", () => {
    for (const d of ["gmail.com", "outlook.com", "yahoo.com", "hotmail.com", "icloud.com"])
      expect(FREE_MAIL_DOMAINS.has(d)).toBe(true);
  });
});
