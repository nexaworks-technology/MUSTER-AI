/**
 * Emulates what the live API does with a structured-output schema: decoding is constrained to the
 * JSON Schema, so an object whose schema has `additionalProperties: false` can only carry the
 * properties it declares. A fake model that bypasses this hides every bug where the schema sent to
 * the model is narrower than the code expects (an empty `properties: {}` object can only be `{}`).
 * Handles objects, arrays and `$ref`s into `$defs`: all the plan and answer schemas use.
 */
type Json = Record<string, unknown>;

export function constrainToSchema(value: unknown, schema: Json, root: Json = schema): unknown {
  const ref = schema.$ref;
  if (typeof ref === "string") {
    const name = ref.replace("#/$defs/", "");
    return constrainToSchema(value, (root.$defs as Record<string, Json>)[name]!, root);
  }
  if (schema.type === "array" && Array.isArray(value))
    return value.map((v) => constrainToSchema(v, (schema.items as Json) ?? {}, root));
  if (schema.type === "object" && value !== null && typeof value === "object") {
    const props = (schema.properties ?? {}) as Record<string, Json>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k in props) out[k] = constrainToSchema(v, props[k]!, root);
      else if (schema.additionalProperties !== false) out[k] = v;
      // else: the decoder cannot emit a key the schema does not declare.
    }
    return out;
  }
  return value;
}
