# validation

`createDbValidatorPlugin()` returns a plugin that extends the Atscript validator with DB-specific checks: field-op detection, patch vs replace vs insert mode, FK presence, nav-field non-optionality, `@db.depth.limit` depth gate.

## API

```ts
import {
  createDbValidatorPlugin,
  buildDbValidator,
  dbValidatorOptions, // 0.1.170 — the options buildDbValidator uses
  normalizeWritePayload, // 0.1.170 — @normalize.* on a write payload
  buildValidationContext,
  type ValidatorMode,
  type DbValidationContext,
} from "@atscript/db";

type ValidatorMode = "insert" | "patch" | "replace";
```

## Server-side

`AtscriptDbTable` builds one validator per mode lazily. For custom write pipelines:

```ts
const validator = buildDbValidator(UsersType, "insert", adapter.getValidatorPlugins());
validator.validate(data); // throws ValidatorError on failure
```

On a table: `table.getValidator("insert")` binds its mode when called without a context (0.1.165); `table.validateRows(rows, mode, { fk })` validates rows exactly as a write would — see [crud.md](crud.md#validate-without-writing--validaterows-01165).

`extraPlugins` are prepended — adapters surface these via `getValidatorPlugins()` (e.g. Mongo's `validateMongoIdPlugin`). See the modes table below for behaviour per mode.

## Normalization: `@normalize.*` (0.1.170)

Every write applies the type's `@normalize.trim` / `@normalize.lowercase` / `@normalize.uppercase` (atscript 0.2.7) and stores the result. Order: **defaults → normalize → validate** — the validator checks the normalized value.

- All write paths: `insertOne/insertMany` (incl. `onConflict: "ignore"`), `replaceOne/bulkReplace/replaceMany`, `updateOne/bulkUpdate/updateMany`, `validateRows`; moost-db POST/PUT/PATCH go through them.
- Patches: plain values, nested objects, array operators (`$replace`/`$insert`/`$upsert` items, `$update`/`$remove` items = the keys that find elements: `$remove: [" RED "]` removes stored `"red"`); `$inc/$dec/$mul` untouched.
- Nested writes: TO/FROM/VIA rows, insert/replace and patch operators — once, at the root call. Defaults are normalized where they are filled (a nested row's `@db.default` too).
- Keys: a unique-key collision is judged on the normalized value; a patch addressed by a unique field, `table.recordFilter(payload)` and `touchMany` keys use the normalized value.
- Pure, copy-on-change (caller's payload untouched); near-zero cost: a type reaching no `@normalize.*` is not walked; one reaching it only through a relation walks each row once. A write guard sees normalized rows; values it sets are validated, not re-normalized.
- Lookups: operands of implicit equality / `$eq` / `$ne` / `$in` / `$nin` on a normalized field (root filter, `updateMany`/`deleteMany`, `$with` filters, `$some`/`$none`) and every id (`findById`, `resolveRowFilter`, `deleteOne`, `GET /one/:id`, composite + unique-key ids) are normalized. NEVER: `$regex`, `$search`/fulltext, ranges, `$exists`, aggregate conditions, `$having`.
- Legacy rows (stored before 0.1.170, not normalized) are no longer found by their old exact value, and new FK/VIA values (refs inherit the target's normalizers) no longer match legacy keys — rewrite them once with a data step through `space.getAdapter(T)` + `normalizeWritePayload(T, row, "replace")` (recipe in docs `guide/upgrading.md#v0-1-170`).

```ts
import { normalizeWritePayload, dbValidatorOptions } from "@atscript/db/validator";
const opts = dbValidatorOptions(User, "patch"); // build once per mode and reuse it
const patch = normalizeWritePayload(User, { id: 1, email: " A@X " }, "patch", opts);
```

`opts` = the options the result will be validated with — they decide between union members whose normalized results differ.

## Client-side

The browser `Client` builds a validator from the `/meta` payload:

```ts
const validator = await client.getValidator();
const data = validator.normalize(payload, "insert"); // @normalize.* (0.1.170) — write methods do this
validator.validate(data, "insert");
validator.validate(validator.normalize(patch, "patch"), "patch");
```

The client's write methods normalize, validate, and send the normalized data. `validate()` alone never normalizes.

Server and client share the plugin — same partial logic, same ref-depth gate. The client validator reconstructs `flatMap` + `navFields` via `buildValidationContext(deserializedType)`.

`isServerStampedOnUpdate(metadata)` / `SERVER_STAMPED_ON_UPDATE_KEYS` (0.1.163, `@atscript/db/validator`, no compiler dependency): `true` when the field has `@db.onUpdate.now` or `@db.onUpdate.inc` — the server overwrites it on every update; use it in UI/plugin code (e.g. read-only in edit forms) instead of listing the keys.

## Error shape

Every entry also carries `code` + `params` (db plugin codes since 0.1.170, `DB_VALIDATOR_MESSAGES`; client preflight entries keep them) — translation rules → [i18n.md](i18n.md).

```ts
// @atscript/typescript
class ValidatorError extends Error {
  readonly errors: Array<{ path: string; message: string }>;
}

// @atscript/db-client
class ClientValidationError extends Error {
  readonly errors: Array<{ path: string; message: string }>;
}
```

Moost HTTP transforms both into:

```json
{
  "statusCode": 400,
  "message": "...",
  "errors": [{ "path": "email", "message": "Expected email format" }]
}
```

`ClientError.errors` exposes the same array on 4xx responses.

## Navigation & FK gates

- **Nav props are stripped from inserts.** Declaring `@db.rel.to author: User` doesn't make `author` writable — the server expects the FK (`authorId`), not the nested target. Nested writes require `@db.depth.limit N`.
- **`@db.rel.FK` without a target.** Server runs an FK existence check through the integrity strategy — application-level `SELECT COUNT(*)` for non-native adapters, database constraint for native.
- **`@db.depth.limit N`.** Write payloads (insert / replace / patch) nested beyond depth `N` → `DbError('DEPTH_EXCEEDED')` (`DepthLimitExceededError`) → HTTP 400.

## Field ops

`isDbFieldOp(value)` returns `true` for `{ $inc: n }` / `{ $dec: n }` / `{ $mul: n }`. The validator accepts field-op shapes on numeric fields in patch mode; rejects them in insert/replace modes.

## Version column

Tables with `@db.column.version` reject any direct write to the version field (plain SET, `$inc`, or `$mul`) at the patch-decomposer layer with `DbError("VERSION_COLUMN_WRITE")` (HTTP 400). The column is server-managed; clients read it and round-trip it via `$cas` only. The moost-db controller auto-lifts `version` in a PATCH/PUT body to `$cas` before the decomposer runs, so REST clients never trip this rejection. See [versioning.md](versioning.md).

Since 0.1.128 `db.column.version` sits on the shared plugin's server-managed skip list next to `@db.default*` / `@db.rel.FK`: `insert` / `replace` accept a missing version at ANY depth (nested versioned targets included), on the server AND in `@atscript/db-client` preflight — one builder (`buildDbValidator`), no server-only branch. `undefined` values are pruned before validation, so they never change a verdict versus omission.

`db.column.derived` is on the same skip list (0.1.141) and the plugin rejects `$inc/$dec/$mul` on it. db-client sees it since 0.1.142, when moost-db's `/meta` type stopped stripping the annotation — any annotation the plugin reads must be in `getSerializeOptions()`'s whitelist ([moost-db.md § Meta endpoint shape](moost-db.md#meta-endpoint-shape)) or client preflight silently diverges.

## Custom validators per adapter

```ts
// In a custom adapter
getValidatorPlugins(): TValidatorPlugin[] {
  return [myCustomPlugin]        // prepended before the built-in db plugin
}
```

Shared examples:

- `validateMongoIdPlugin` (`@atscript/db-mongo`) — rejects malformed ObjectId strings.
- Consumer-level: validate `@db.pg.type 'INET'` fields, DB-specific string formats, etc.

## Validator modes at a glance

| Endpoint   | Mode      | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/`   | `insert`  | Full validation. Required fields must be present (unless `@db.default*`).                                                                                                                                                                                                                                                                                                                                                        |
| PUT `/`    | `replace` | Full validation including every non-optional non-defaulted field.                                                                                                                                                                                                                                                                                                                                                                |
| PATCH `/`  | `patch`   | Path-aware partial. Top-level fields of the payload are optional. Inside replace-strategy nested objects (default), required children must be present (else 400) — optional children that the user omits are null-filled at storage. `@db.patch.strategy 'merge'` makes that one level partial; descendants without the annotation revert to default replace + strict. `@db.json` always strict. Field ops + array ops accepted. |
| DELETE `…` | (none)    | ID structure validated by `extractCompositeId()` when composite. No body validation.                                                                                                                                                                                                                                                                                                                                             |
| GET `/…`   | (none)    | URL parser plus the capability gate (since 0.1.128: every root path checked against `/meta.fields`; nav paths, JSON descendants on SQL, nested-object parents, unknown fields → 400 envelope). `$with` sub-controls validated against the target relation. `null` is accepted for every optional prop in writes AND typed for optional columns in filters.                                                                       |
