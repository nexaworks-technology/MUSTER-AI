import { parse } from "csv-parse/sync";
import { parseMoney } from "@/lib/money";
import type { ImportTemplate, TemplateField } from "./templates";

/**
 * Pure CSV parsing, mapping and row validation for imports (D-47). Row numbers match what a
 * spreadsheet shows (the header is row 1). Every problem is reported in plain words; no row is
 * silently dropped or merged.
 */
export const MAX_IMPORT_ROWS = 50_000;

export type ParsedCsv =
  { ok: true; headers: string[]; rows: string[][] } | { ok: false; error: string };

export function parseCsv(bytes: Uint8Array): ParsedCsv {
  let all: string[][];
  try {
    all = parse(Buffer.from(bytes), {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as string[][];
  } catch (error) {
    const where = (error as { lines?: number }).lines;
    return {
      ok: false,
      error: `The file couldn't be read as CSV${where ? ` (near line ${where})` : ""}. Check for an unclosed quote.`,
    };
  }
  const [headers, ...rows] = all;
  if (!headers || headers.every((h) => h === ""))
    return { ok: false, error: "The file has no header row." };
  if (rows.length > MAX_IMPORT_ROWS)
    return {
      ok: false,
      error: `A file can have at most ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows. Split it into smaller files.`,
    };
  return { ok: true, headers, rows };
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/** Field key → CSV column, matched by key or label. Unmatched columns are ignored. */
export function autoMap(
  headers: readonly string[],
  template: ImportTemplate,
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const field of template.fields) {
    const hit = headers.find((h) => norm(h) === norm(field.key) || norm(h) === norm(field.label));
    if (hit) mapping[field.key] = hit;
  }
  return mapping;
}

export interface RowError {
  row: number;
  message: string;
}

export interface ValidRecord {
  row: number;
  values: Record<string, unknown>;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

function label(field: TemplateField) {
  return field.label.toLowerCase();
}

function parseValue(
  field: TemplateField,
  raw: string,
  row: number,
  rowCurrency: string,
): { value?: unknown; error?: string } {
  const spec = field.spec;
  const bad = (what: string) => ({ error: `Row ${row}: ${label(field)} '${raw}' ${what}` });
  switch (spec.type) {
    case "text":
      return raw.length > spec.max ? bad(`is longer than ${spec.max} characters.`) : { value: raw };
    case "email":
      return EMAIL.test(raw)
        ? { value: raw.toLowerCase() }
        : { error: `Row ${row}: ${label(field)} '${raw}' is not an email address.` };
    case "date": {
      const m = DATE.exec(raw);
      const d = m ? new Date(`${raw}T00:00:00Z`) : null;
      return d && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw
        ? { value: d }
        : bad("is not a date (use YYYY-MM-DD, e.g. 2026-10-31).");
    }
    case "datetime": {
      const d = DATE.test(raw)
        ? new Date(`${raw}T00:00:00Z`)
        : /^\d{4}-\d{2}-\d{2}T/.test(raw)
          ? new Date(raw)
          : null;
      return d && !Number.isNaN(d.getTime())
        ? { value: d }
        : bad("is not a date and time (use e.g. 2026-10-31T14:00:00Z).");
    }
    case "int":
      return /^\d{1,9}$/.test(raw) ? { value: Number(raw) } : bad("is not a whole number.");
    case "money":
      try {
        return { value: parseMoney(raw, rowCurrency).minor };
      } catch {
        return bad("is not an amount (use digits and a dot, e.g. 3000.50).");
      }
    case "currency":
      return VALID_CURRENCIES.has(raw.toUpperCase())
        ? { value: raw.toUpperCase() }
        : bad("is not a currency code (e.g. USD).");
    case "bool": {
      const v = raw.toLowerCase();
      if (["yes", "true", "1", "y"].includes(v)) return { value: true };
      if (["no", "false", "0", "n"].includes(v)) return { value: false };
      return bad("is not yes or no.");
    }
    case "enum": {
      const value = spec.values[raw.toLowerCase()];
      if (value) return { value };
      const shown = [
        ...new Set(
          Object.entries(spec.values)
            .filter(([k, v], i, arr) => arr.findIndex(([, v2]) => v2 === v) === i && k)
            .map(([k]) => k),
        ),
      ];
      return bad(
        `is not one of: ${shown.map((k) => k.charAt(0).toUpperCase() + k.slice(1)).join(", ")}.`,
      );
    }
  }
}

export function validateRows(
  template: ImportTemplate,
  headers: readonly string[],
  rows: readonly string[][],
  mapping: Record<string, string>,
  ctx: { baseCurrency: string },
): { records: ValidRecord[]; errors: RowError[] } {
  const index = new Map(headers.map((h, i) => [h, i]));
  const records: ValidRecord[] = [];
  const errors: RowError[] = [];
  const firstSeen = new Map<string, number>();
  const keyField = template.fields[0]!.required ? template.fields[0]! : null;

  rows.forEach((cells, i) => {
    const row = i + 2;
    if (cells.length !== headers.length) {
      errors.push({
        row,
        message: `Row ${row}: has ${cells.length} values but the header has ${headers.length} columns.`,
      });
      return;
    }
    const cell = (key: string) => {
      const col = mapping[key];
      return col !== undefined && index.has(col) ? (cells[index.get(col)!] ?? "").trim() : "";
    };
    const currencyRaw = cell("currency");
    const rowCurrency =
      currencyRaw && VALID_CURRENCIES.has(currencyRaw.toUpperCase())
        ? currencyRaw.toUpperCase()
        : ctx.baseCurrency;
    const values: Record<string, unknown> = {};
    const rowErrors: string[] = [];
    for (const field of template.fields) {
      const raw = cell(field.key);
      if (raw === "") {
        if (field.required) rowErrors.push(`Row ${row}: ${label(field)} is required.`);
        continue;
      }
      const parsed = parseValue(field, raw, row, rowCurrency);
      if (parsed.error) rowErrors.push(parsed.error);
      else values[field.key] = parsed.value;
    }
    if (template.fields.some((x) => x.spec.type === "money") && values.currency === undefined)
      values.currency = ctx.baseCurrency;
    if (template.oneOf && !template.oneOf.some((k) => values[k] !== undefined)) {
      rowErrors.push(`Row ${row}: give either ${template.oneOf[0]} or ${template.oneOf[1]}.`);
    }
    if (rowErrors.length > 0) {
      errors.push(...rowErrors.map((message) => ({ row, message })));
      return;
    }
    const key = dedupeKey(template, values);
    if (key) {
      const first = firstSeen.get(key);
      if (first !== undefined) {
        const shownKey = keyField
          ? `${keyField.key} '${String(values[keyField.key])}'`
          : "this row";
        errors.push({
          row,
          message: `Row ${row}: ${shownKey} is repeated (first used on row ${first}).`,
        });
        return;
      }
      firstSeen.set(key, row);
    }
    records.push({ row, values });
  });
  return { records, errors };
}

/** The within-file identity of a row (same rule as the database dedupe, D-47). */
export function dedupeKey(template: ImportTemplate, v: Record<string, unknown>): string | null {
  const acct = String(v.account_id ?? `domain:${String(v.account_domain ?? "").toLowerCase()}`);
  const day = v.date instanceof Date ? v.date.toISOString().slice(0, 10) : "";
  switch (template.kind) {
    case "CONTACTS":
      return v.contact_id ? `id:${String(v.contact_id)}` : `email:${String(v.email)}`;
    case "USAGE_ACCOUNT_DAILY":
      return `${acct}|${day}`;
    case "USAGE_USER_DAILY":
      return `${acct}|${String(v.user_id)}|${day}`;
    case "USAGE_FEATURE_DAILY":
      return `${acct}|${String(v.feature_key)}|${day}`;
    default:
      return String(v[template.fields[0]!.key]);
  }
}
