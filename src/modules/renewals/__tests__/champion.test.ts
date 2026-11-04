import { describe, expect, it } from "vitest";
import type { AccountBundle } from "@/modules/health/service";
import { championState } from "../champion";

/** The single champion-silence definition (M7 j): M9's rule will reuse it, so it is pinned here. */
const bundle = (over: Record<string, unknown> = {}) =>
  ({
    accountId: "acc",
    asOf: "2026-11-02",
    contacts: [{ id: "c1", name: "Dana", status: "ACTIVE", statusDate: null }],
    roles: [
      { id: "r1", contactId: "c1", role: "CHAMPION", validFrom: "2026-01-01", validTo: null },
    ],
    messages: [],
    userUsage: null,
    ...over,
  }) as unknown as AccountBundle;
const msg = (id: string, date: string, from = "c1", direction = "INBOUND") => ({
  id,
  conversationId: "cv",
  channel: "EMAIL",
  direction,
  date,
  fromContactId: from,
  isBounce: false,
});

describe("championState", () => {
  it("is null with no champion role on record (not bad news, Rule 4)", () => {
    expect(championState(bundle({ roles: [] }), 30)).toBeNull();
  });

  it("is silent from the last inbound message, at exactly the threshold", () => {
    const at = (date: string) => championState(bundle({ messages: [msg("m1", date)] }), 30)!;
    expect(at("2026-10-03")).toMatchObject({
      state: "SILENT",
      silentDays: 30,
      lastHeard: "2026-10-03",
    });
    expect(at("2026-10-04")).toMatchObject({ state: "ACTIVE", silentDays: 29 });
    expect(at("2026-09-29").silentDays).toBe(34);
    expect(at("2026-09-29").sources).toEqual([
      { sourceType: "Contact", sourceId: "c1" },
      { sourceType: "Message", sourceId: "m1" },
    ]);
  });

  it("counts product activity as being heard, and ignores outbound mail and other people", () => {
    const b = bundle({
      messages: [msg("out", "2026-10-30", "c1", "OUTBOUND"), msg("other", "2026-10-30", "c2")],
      userUsage: [
        { externalUserId: "u", contactId: "c1", name: "Dana", date: "2026-10-25", events: 4 },
      ],
    });
    expect(championState(b, 30)).toMatchObject({ state: "ACTIVE", lastHeard: "2026-10-25" });
  });

  it("counts from the start of the role when the champion was never heard from", () => {
    expect(championState(bundle(), 30)).toMatchObject({
      state: "SILENT",
      silentDays: 305,
      lastHeard: null,
    });
  });

  it("never reads a message dated after the as-of date", () => {
    const b = bundle({ messages: [msg("future", "2026-11-20"), msg("old", "2026-09-01")] });
    expect(championState(b, 30)).toMatchObject({ state: "SILENT", lastHeard: "2026-09-01" });
  });

  it("is gone when they left or bounced (from the date it became true), or the role ended", () => {
    const left = (statusDate: string | null) =>
      championState(
        bundle({
          contacts: [{ id: "c1", name: "Dana", status: "LEFT", statusDate }],
          messages: [msg("m", "2026-10-30")],
        }),
        30,
      )!.state;
    expect(left("2026-10-01")).toBe("GONE");
    expect(left("2026-12-01")).toBe("ACTIVE"); // not yet true on the as-of date
    const ended = championState(
      bundle({
        roles: [
          {
            id: "r1",
            contactId: "c1",
            role: "CHAMPION",
            validFrom: "2026-01-01",
            validTo: "2026-10-01",
          },
        ],
      }),
      30,
    )!;
    expect(ended).toMatchObject({ state: "GONE", name: "Dana", silentDays: null });
  });
});
