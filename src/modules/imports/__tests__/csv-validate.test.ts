import { describe, expect, it } from "vitest";
import { autoMap, parseCsv, validateRows, MAX_IMPORT_ROWS } from "../parse";
import { TEMPLATES } from "../templates";

const csv = (s: string) => Buffer.from(s.trim() + "\n");

describe("CSV parsing", () => {
  it("reads headers and rows, ignoring a byte-order mark and blank lines", () => {
    const parsed = parseCsv(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        csv('account_id,name\nA-1,Acme\n\nA-2,"Beta, Inc"'),
      ]),
    );
    expect(parsed).toMatchObject({
      ok: true,
      headers: ["account_id", "name"],
      rows: [
        ["A-1", "Acme"],
        ["A-2", "Beta, Inc"],
      ],
    });
  });

  it("explains a broken file in plain words instead of failing silently", () => {
    expect(parseCsv(csv('name\n"unclosed quote'))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/couldn't be read as CSV/),
    });
    expect(parseCsv(csv(""))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no header row/),
    });
  });

  it(`refuses files over ${MAX_IMPORT_ROWS} rows`, () => {
    const big = "name\n" + "x\n".repeat(MAX_IMPORT_ROWS + 1);
    expect(parseCsv(Buffer.from(big))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/at most/),
    });
  });
});

describe("column mapping", () => {
  it("maps headers to fields by key or label, ignoring case, spaces and underscores", () => {
    expect(
      autoMap(["Account ID", "NAME", "Tier", "Owner Email", "Notes"], TEMPLATES.ACCOUNTS),
    ).toEqual({
      account_id: "Account ID",
      name: "NAME",
      tier: "Tier",
      owner_email: "Owner Email",
    });
  });
});

describe("row validation (plain words, nothing silently skipped)", () => {
  const t = TEMPLATES.ACCOUNTS;
  const headers = ["account_id", "name", "tier", "stage", "onboarding_started"];
  const mapping = autoMap(headers, t);

  it("turns valid rows into typed records", () => {
    const { records, errors } = validateRows(
      t,
      headers,
      [["A-1", "Acme", "Mid-touch", "adopting", "2026-10-01"]],
      mapping,
      { baseCurrency: "USD" },
    );
    expect(errors).toEqual([]);
    expect(records[0]).toEqual({
      row: 2,
      values: {
        account_id: "A-1",
        name: "Acme",
        tier: "MID_TOUCH",
        stage: "ADOPTING",
        onboarding_started: new Date("2026-10-01T00:00:00Z"),
      },
    });
  });

  it("reports each problem with its spreadsheet row number and the bad value", () => {
    const { records, errors } = validateRows(
      t,
      headers,
      [
        ["A-1", "", "Mid-touch", "", ""],
        ["A-2", "Beta", "Platinum", "", ""],
        ["A-3", "Gamma", "Long-tail", "Sleeping", ""],
        ["A-4", "Delta", "High-touch", "", "31/13/2026"],
      ],
      mapping,
      { baseCurrency: "USD" },
    );
    expect(records).toEqual([]);
    expect(errors.map((e) => e.message)).toEqual([
      "Row 2: name is required.",
      "Row 3: tier 'Platinum' is not one of: High-touch, Mid-touch, Long-tail.",
      "Row 4: stage 'Sleeping' is not one of: Onboarding, Adopting, Mature, Renewing, Lost.",
      "Row 5: onboarding started '31/13/2026' is not a date (use YYYY-MM-DD, e.g. 2026-10-31).",
    ]);
  });

  it("flags a repeated key within the file instead of merging rows", () => {
    const { records, errors } = validateRows(
      t,
      headers,
      [
        ["A-1", "Acme", "Mid-touch", "", ""],
        ["A-1", "Acme again", "Mid-touch", "", ""],
      ],
      mapping,
      { baseCurrency: "USD" },
    );
    expect(records).toHaveLength(1);
    expect(errors.map((e) => e.message)).toEqual([
      "Row 3: account_id 'A-1' is repeated (first used on row 2).",
    ]);
  });

  it("requires one of account_id or account_domain where a template needs an account", () => {
    const ct = TEMPLATES.CONTACTS;
    const h = ["email", "name"];
    const { errors } = validateRows(ct, h, [["pat@acme.test", "Pat"]], autoMap(h, ct), {
      baseCurrency: "USD",
    });
    expect(errors[0]!.message).toBe("Row 2: give either account_id or account_domain.");
  });

  it("parses money in the row's currency and rejects bad amounts and emails", () => {
    const it2 = TEMPLATES.INVOICES;
    const h = [
      "invoice_number",
      "account_id",
      "amount",
      "currency",
      "issued_date",
      "due_date",
      "paid_date",
    ];
    const ok = validateRows(
      it2,
      h,
      [["I-1", "A-1", "3000.50", "", "2026-10-01", "2026-10-31", ""]],
      autoMap(h, it2),
      { baseCurrency: "USD" },
    );
    expect(ok.records[0]!.values).toMatchObject({ amount: 300050n, currency: "USD" });
    const bad = validateRows(
      it2,
      h,
      [["I-2", "A-1", "3,000", "EUR", "2026-10-01", "2026-10-31", ""]],
      autoMap(h, it2),
      { baseCurrency: "USD" },
    );
    expect(bad.errors[0]!.message).toBe(
      "Row 2: amount '3,000' is not an amount (use digits and a dot, e.g. 3000.50).",
    );
    const ct = TEMPLATES.CONTACTS;
    const hc = ["account_id", "email", "name"];
    expect(
      validateRows(ct, hc, [["A-1", "not-an-email", "Pat"]], autoMap(hc, ct), {
        baseCurrency: "USD",
      }).errors[0]!.message,
    ).toBe("Row 2: email 'not-an-email' is not an email address.");
  });

  it("reports rows with the wrong number of columns", () => {
    const { errors } = validateRows(t, headers, [["A-9", "Too", "few"]], mapping, {
      baseCurrency: "USD",
    });
    expect(errors[0]!.message).toBe("Row 2: has 3 values but the header has 5 columns.");
  });
});
