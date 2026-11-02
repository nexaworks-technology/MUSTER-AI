import { describe, expect, it } from "vitest";
import { parseMentions } from "../mentions";

const members = [
  { membershipId: "m-aisha", name: "Aisha Bello" },
  { membershipId: "m-leo", name: "Leo Marsh" },
  { membershipId: "m-leon", name: "Leon" },
];

describe("@mention parsing", () => {
  it("finds full-name mentions, case-insensitively, once each", () => {
    expect(parseMentions("Ping @Aisha Bello and @aisha bello about the SSO step", members)).toEqual(
      ["m-aisha"],
    );
  });

  it("prefers the longest matching name", () => {
    expect(parseMentions("Thanks @Leo Marsh", members)).toEqual(["m-leo"]);
    expect(parseMentions("Thanks @Leon!", members)).toEqual(["m-leon"]);
  });

  it("ignores emails and unknown names", () => {
    expect(parseMentions("mail aisha@larkspur.test or @Nobody Here", members)).toEqual([]);
  });

  it("requires a word boundary after the name", () => {
    expect(parseMentions("@Aisha Bellox", members)).toEqual([]);
  });
});
