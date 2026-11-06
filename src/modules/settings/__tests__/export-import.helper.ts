import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { fieldCipher } from "@/lib/crypto";
import { createTestUser } from "@/test/fixtures";
import { scopedDb } from "@/lib/db/scoped";
import { TENANT_MODELS } from "@/lib/db/tenantModels";

/**
 * TEST-ONLY importer for the export round-trip (M12 B1). The product has no "import a workspace
 * export" feature; this reads the export's JSON back into a scratch workspace so the test can
 * compare per-entity counts. It remaps every id and foreign key, derives the field-encrypted
 * columns from the exported plaintext, and fills the credential columns the export leaves out
 * with throwaway values.
 */
type Json = Record<string, unknown>;
type Field = (typeof Prisma.dmmf.datamodel.models)[number]["fields"][number];

const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
const tenant = new Set<string>(TENANT_MODELS);
const delegateOf = (m: string) => m.charAt(0).toLowerCase() + m.slice(1);

interface Fk {
  field: Field;
  target: string;
  /** The relation's scalar columns other than workspaceId. */
  columns: string[];
}

function foreignKeys(model: string): Fk[] {
  return models
    .get(model)!
    .fields.filter((f) => f.kind === "object" && f.relationFromFields?.length)
    .map((f) => ({
      field: f,
      target: f.type,
      columns: f.relationFromFields!.filter((c) => c !== "workspaceId"),
    }))
    .filter((fk) => fk.columns.length > 0);
}

/** Insertion order: a model after everything it requires, optional edges honoured when possible. */
export function importOrder(): string[] {
  const todo = new Set<string>(TENANT_MODELS);
  const done: string[] = [];
  const deps = (m: string, hardOnly: boolean) =>
    foreignKeys(m)
      .filter((fk) => tenant.has(fk.target) && fk.target !== m)
      .filter(
        (fk) =>
          !hardOnly ||
          fk.columns.every((c) => models.get(m)!.fields.find((f) => f.name === c)!.isRequired),
      )
      .map((fk) => fk.target);
  while (todo.size > 0) {
    const ready = [...todo].filter((m) => deps(m, false).every((d) => !todo.has(d)));
    const pick =
      ready.length > 0 ? ready : [...todo].filter((m) => deps(m, true).every((d) => !todo.has(d)));
    if (pick.length === 0) throw new Error(`import order stuck on ${[...todo].join(",")}`);
    for (const m of pick) {
      todo.delete(m);
      done.push(m);
    }
  }
  return done;
}

function revive(field: Field, value: unknown): unknown {
  if (value === null || value === undefined) {
    return field.type === "Json" && !field.isRequired ? Prisma.DbNull : null;
  }
  if (field.type === "DateTime") return new Date(value as string);
  if (field.type === "BigInt") return BigInt(value as string);
  return value;
}

export interface ImportResult {
  counts: Record<string, number>;
}

export async function importExport(
  files: Record<string, unknown>,
  workspaceId: string,
): Promise<ImportResult> {
  const cipher = fieldCipher();
  const tag = randomUUID().slice(0, 8);
  const idMap = new Map<string, string>(); // `${model}:${oldId}` -> new id
  const patches: Array<{ model: string; id: string; target: string; cols: Json }> = [];
  const counts: Record<string, number> = {};
  const db = scopedDb({ workspaceId }) as unknown as Record<
    string,
    {
      createMany: (a: { data: Json[] }) => Promise<unknown>;
      update: (a: { where: Json; data: Json }) => Promise<unknown>;
    }
  >;
  const inserted = new Set<string>();

  for (const model of importOrder()) {
    const rows = (files[model] as Json[] | undefined) ?? [];
    counts[model] = rows.length;
    const meta = models.get(model)!;
    const fks = foreignKeys(model);
    const data: Json[] = [];
    for (const row of rows) {
      const newId = `imp${randomUUID().replaceAll("-", "")}`;
      idMap.set(`${model}:${String(row.id)}`, newId);
      const out: Json = {};
      for (const f of meta.fields.filter((x) => x.kind !== "object")) {
        let raw = row[f.name];
        if (model === "Contract" && f.name === "termsEnc")
          raw = row.terms == null ? null : cipher.encrypt(String(row.terms));
        if (model === "Contract" && f.name === "pricingNotesEnc")
          raw = row.pricingNotes == null ? null : cipher.encrypt(String(row.pricingNotes));
        if (raw === undefined && f.isRequired && f.type === "String")
          raw = `scratch-${randomUUID()}`;
        else if (raw === undefined && f.name !== "id") raw = null;
        if (f.isUnique && f.type === "String" && typeof raw === "string" && f.name !== "id")
          raw = `${raw}~${tag}`;
        out[f.name] = revive(f, raw);
      }
      out.id = newId;
      out.workspaceId = workspaceId;
      if (model === "Membership") {
        const user = await createTestUser("scratch");
        out.userId = user.id;
      }
      for (const fk of fks) {
        if (!tenant.has(fk.target)) continue;
        const later: Json = {};
        for (const c of fk.columns) {
          const oldValue = row[c];
          if (oldValue == null) continue;
          if (inserted.has(fk.target)) {
            const mapped = idMap.get(`${fk.target}:${String(oldValue)}`);
            if (!mapped)
              throw new Error(`dangling ${model}.${c} -> ${fk.target}:${String(oldValue)}`);
            out[c] = mapped;
          } else {
            later[c] = String(oldValue); // resolved once every model is in
            out[c] = null;
          }
        }
        if (Object.keys(later).length)
          patches.push({ model, id: newId, target: fk.target, cols: later });
      }
      data.push(out);
    }
    // Insert in chunks; rows of one model are independent once deferred links are nulled.
    for (let i = 0; i < data.length; i += 500)
      await db[delegateOf(model)]!.createMany({ data: data.slice(i, i + 500) });
    inserted.add(model);
  }

  for (const p of patches) {
    const data: Json = {};
    for (const [c, old] of Object.entries(p.cols)) {
      const mapped = idMap.get(`${p.target}:${String(old)}`);
      if (!mapped) throw new Error(`dangling deferred ${p.model}.${c}`);
      data[c] = mapped;
    }
    await db[delegateOf(p.model)]!.update({ where: { id: p.id }, data });
  }
  return { counts };
}
