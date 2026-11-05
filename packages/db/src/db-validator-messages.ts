/**
 * English templates of the errors the db validator plugin reports, by code
 * (since 0.1.170). Each error carries its `code` and the `params` its
 * template names (`{name}`); its `message` is the template filled with them.
 * Translate them like the validator's own codes (`VALIDATOR_MESSAGES`):
 * `registerMessages(DB_VALIDATOR_MESSAGES)` on a moost server (moost-db does
 * it on import), `localizeErrors()` on a client.
 */
export const DB_VALIDATOR_MESSAGES = Object.freeze({
  /** A `db.geoPoint` value is not a `[lng, lat]` pair of finite numbers. */
  GEO_POINT_SHAPE: "Expected a [lng, lat] tuple of two finite numbers (GeoJSON order)",
  /** A `db.geoPoint` longitude outside [-180, 180]. */
  GEO_LONGITUDE_RANGE: "Longitude {value} out of range [-180, 180] (geo points are [lng, lat])",
  /** A `db.geoPoint` latitude outside [-90, 90]. */
  GEO_LATITUDE_RANGE: "Latitude {value} out of range [-90, 90] (geo points are [lng, lat])",
  /** `$inc` / `$dec` / `$mul` on a `@db.column.derived` field. */
  FIELD_OP_ON_DERIVED:
    "Field operations ($inc/$dec/$mul) are not allowed on a @db.column.derived field — it is computed from its @db.json source; patch the source leaf instead",
  /** A field operation inside `@db.json`, an array item or a non-merge nested object. */
  FIELD_OP_CONTEXT:
    'Field operations ($inc/$dec/$mul) are not supported inside @db.json fields, array items, or nested objects without @db.patch.strategy "merge"',
  /** A field operation on a field that is not a number. */
  FIELD_OP_NOT_NUMERIC: "Field operations ($inc/$dec/$mul) can only be applied to numeric fields",
  /** A field operation's operand is `NaN` or an infinity. `{ operand }`: the operand as text. */
  FIELD_OP_NOT_FINITE: "Field operation operand must be a finite number, got {operand}",
  /** A navigation property set to `null`. */
  NAV_NULL: "Cannot process null navigation property '{field}'",
  /** A 1:N / M:N relation patched with a plain value. `{ relation }`: `1:N` / `M:N`. */
  NAV_PATCH_PLAIN_VALUE:
    "Cannot patch {relation} relation '{field}' with a plain value — use patch operators ({ $insert, $remove, $replace, $update, $upsert })",
  /** Patch operators on a relation that is not an array. */
  NAV_PATCH_NOT_ARRAY: "Cannot use patch operators on non-array relation '{field}'",
  /** An array patch mixing operators with unknown keys. `{ operators }`: the unknown keys. */
  PATCH_UNKNOWN_OPERATOR:
    "Unknown patch operator(s): {operators}. Allowed: $replace, $insert, $upsert, $update, $remove",
  /** `$update` / `$remove` given something other than an array. */
  PATCH_OPERAND_NOT_ARRAY: "{op} must be an array",
  /** An `$update` / `$remove` item of an object array that is not an object. */
  PATCH_ITEM_NOT_OBJECT: "{op}[{index}]: expected object",
  /** An `$update` / `$remove` item without its `@expect.array.key` field. */
  PATCH_KEY_REQUIRED: "{op}[{index}]: key field '{field}' is required",
  /** A replace-strategy `$update` item without a required field. */
  PATCH_FIELD_REQUIRED: "{op}[{index}]: field '{field}' is required (replace strategy)",
});

/** A code of {@link DB_VALIDATOR_MESSAGES}. */
export type TDbValidatorErrorCode = keyof typeof DB_VALIDATOR_MESSAGES;
