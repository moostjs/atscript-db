# validation

`createDbValidatorPlugin()` returns a plugin that extends the Atscript validator with DB-specific checks: field-op detection, patch vs replace vs insert mode, FK presence, nav-field non-optionality, `@db.depth.limit` depth gate.

## API

```ts
import {
  createDbValidatorPlugin,
  buildDbValidator,
  buildValidationContext,
  type ValidatorMode,
  type DbValidationContext,
} from "@atscript/db";

type ValidatorMode = "insert" | "patch" | "replace";
```

## Server-side

`AtscriptDbTable` builds one validator per mode lazily — consumers don't call this directly. For custom write pipelines:

```ts
const validator = buildDbValidator(UsersType, "insert", adapter.getValidatorPlugins());
validator.validate(data); // throws ValidatorError on failure
```

`buildDbValidator(type, mode, extraPlugins?)`:

- `mode === 'insert'` → full-shape validation; auto-generated and defaulted fields may be omitted.
- `mode === 'replace'` → full-shape validation; every non-optional non-defaulted field required.
- `mode === 'patch'` → top-level partial. `AtscriptDbTable.bulkUpdate` swaps in a path-aware partial callback (returned by `_buildValidator('bulkUpdate')`):
  - root → **partial** (top-level fields of the patch payload are optional — that's how patch works);
  - paths inside a navigation relation → **partial** (whole sub-tree — nav targets are patched);
  - field annotated `@db.patch.strategy 'merge'` → **partial** (one level only — does not propagate);
  - everything else (replace, including `@db.json` and any nested non-merge object) → **strict** — every required child must be present.
- `replace: forceNavNonOptional` — nav relations are non-optional so the plugin can flag missing nav props vs genuine `null`.
- `extraPlugins` prepend — adapters return these from `getValidatorPlugins()` (e.g. Mongo's `validateMongoIdPlugin` for `mongo.objectId` primitives).

Strict-replace + storage null-fill cooperate: required children must be supplied (validator catches missing ones early with a 400), optional children that the user omits are explicitly nulled by the patch decomposer (`packages/db/src/patch/patch-decomposer.ts`) and Mongo `CollectionPatcher`. This keeps "replace = whole object overwritten" observable on both adapters, and prevents a silent NOT NULL violation reaching the database.

## Client-side

The browser `Client` builds a validator from the `/meta` payload:

```ts
const validator = await client.getValidator();
validator.validate(payload, "insert");
validator.validate(payload, "patch");
```

Server and client share the plugin — same partial logic, same ref-depth gate. The client validator reconstructs `flatMap` + `navFields` via `buildValidationContext(deserializedType)`.

## Error shape

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
| GET `/…`   | (none)    | URL parser plus the filterable/sortable gate. Projection / `$with` validated against `flatMap`.                                                                                                                                                                                                                                                                                                                                  |
