# validation

`createDbValidatorPlugin()` returns a plugin that extends the Atscript validator with DB-specific checks: field-op detection, patch vs replace vs insert mode, FK presence, nav-field non-optionality, `@db.deep.insert` depth.

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

- `mode === 'patch'` → `partial: true` (all fields optional).
- `mode === 'replace'` → full-shape validation.
- `replace: forceNavNonOptional` — nav relations are non-optional so the plugin can flag missing nav props vs genuine `null`.
- `extraPlugins` prepend — adapters return these from `getValidatorPlugins()` (e.g. Mongo's `validateMongoIdPlugin` for `mongo.objectId` primitives).

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

- **Nav props are stripped from inserts.** Declaring `@db.rel.to author: User` doesn't make `author` writable — the server expects the FK (`authorId`), not the nested target. Nested writes require `@db.deep.insert N`.
- **`@db.rel.FK` without a target.** Server runs an FK existence check through the integrity strategy — application-level `SELECT COUNT(*)` for non-native adapters, database constraint for native.
- **`@db.deep.insert N`.** Payloads nested beyond depth `N` → `DbError('DEPTH_EXCEEDED')` (alias class `DeepInsertDepthExceededError`) → HTTP 400.

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

| Endpoint   | Mode      | Behaviour                                                                                       |
| ---------- | --------- | ----------------------------------------------------------------------------------------------- |
| POST `/`   | `insert`  | Full validation. Required fields must be present (unless `@db.default*`).                       |
| PUT `/`    | `replace` | Full validation including every non-optional non-defaulted field.                               |
| PATCH `/`  | `patch`   | Partial — only supplied fields validated. Field ops + array ops accepted.                       |
| DELETE `…` | (none)    | ID structure validated by `extractCompositeId()` when composite. No body validation.            |
| GET `/…`   | (none)    | URL parser plus the filterable/sortable gate. Projection / `$with` validated against `flatMap`. |
