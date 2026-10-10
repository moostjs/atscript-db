---
outline: deep
---

# Defaults & Generated Values

<!--@include: ../_experimental-warning.md-->

Atscript lets you set default values directly in your `.as` schema. Defaults ensure fields are populated automatically on insert — you define them once, and every adapter handles the rest. A last-modified time that every update sets is covered under [Update Timestamps](#on-update).

## Static Defaults

Use `@db.default` to assign a fixed value when a field is not provided at insert time. The argument is always a string — non-string values are parsed as JSON:

```atscript
// String default — used as-is
@db.default 'pending'
status: string

// Boolean default — parsed from JSON
@db.default 'false'
isArchived: boolean

// Number default — parsed from JSON
@db.default '0'
retryCount: number
```

## Generated Defaults

Some defaults need to be computed at insert time. Atscript provides three portable generated-default annotations:

### `@db.default.increment` — Auto-Incrementing Integer

Generates sequential integers (1, 2, 3, ...). The field must be a number type. An optional argument sets the starting value:

```atscript
@db.default.increment
id: number

// With optional start value:
@db.default.increment 1000
id: number
```

### `@db.default.uuid` — Random UUID

Generates a random UUID v4 string. The field must be a string type:

```atscript
@db.default.uuid
id: string
```

### `@db.default.now` — Current Timestamp

Captures the current time at insert. Works with number (Unix epoch milliseconds) and string (ISO format) types:

```atscript
@db.default.now
createdAt?: number
```

Use `number` (epoch ms) for timestamps so they cross HTTP boundaries without any serialization step.

### Semantic types {#semantic-types}

`number.timestamp.created` already includes `@db.default.now`, and `number.timestamp.updated` includes `@db.default.now` and [`@db.onUpdate.now`](#on-update) — you don't need to add them:

```atscript
// Concise — the types carry the annotations
createdAt: number.timestamp.created
updatedAt: number.timestamp.updated

// Equivalent verbose form
@db.default.now
createdAt: number.timestamp

@db.default.now
@db.onUpdate.now
updatedAt: number.timestamp
```

The annotations apply wherever the field's type is `number.timestamp.created` / `number.timestamp.updated`: directly, through a type alias (`type Created = number.timestamp.created`), as `number.timestamp.created | null`, and on a field of an embedded object. They do not apply to a field that references another field (`createdAt: Order.createdAt` copies the type, not the default), to a member of another union (`number.timestamp.created | string`), to a tuple item or to an array element. An explicit `@db.default` on the field wins (for an `updated` field it replaces the insert value only; updates still set the time).

Before 0.1.155 (atscript 0.1.104) the default was not applied to `number.timestamp.created` fields, and before 0.1.156 (atscript 0.1.106) `number.timestamp.updated` was neither filled nor set — see [Upgrading](/guide/upgrading#v0-1-156) for the schema change it brings.

## Update Timestamps {#on-update}

`@db.onUpdate.now` sets a `number` field to the current time (epoch milliseconds) on every update. Pair it with `@db.default.now` to fill it on insert too — `number.timestamp.updated` is that pair:

```atscript
updatedAt: number.timestamp.updated

// last edit only — required on insert, then set by every update
@db.onUpdate.now
editedAt?: number.timestamp
```

- **Which writes set it** — patches (`updateOne`, `bulkUpdate`, `updateMany`) and replaces (`replaceOne`, `bulkReplace`, `replaceMany`), including nested relation writes on the related table's own fields, `PATCH` / `PUT` through [moost-db](/http/crud) and `@atscript/db-client`. Inserts (also with `onConflict: 'ignore'`) are left to the field's default.
- **The SDK writes the time** — one time per call, in the write's own statement, the same on SQLite, PostgreSQL, MySQL, MongoDB and the in-memory adapter: `updateMany` stamps every matched row with it. No engine trigger or `ON UPDATE` clause is created, so writes made outside atscript-db (raw SQL, other clients) leave the field unchanged. On MySQL you can add [`@db.mysql.onUpdate "CURRENT_TIMESTAMP"`](/adapters/mysql#mysql-specific-annotations) for those as well.
- **A value in the payload is overridden** — on a patch or a replace the caller cannot set the field (an HTTP client cannot forge it). On insert an explicit value wins, as for every default; strip it in an `onWrite` hook if clients must not choose it.
- **[Write guards](/api/crud#write-guards)** see the time in a replace's rows; a patch's rows do not carry the row's own update fields — the time is added after the guard, when the patch is known to write something.
- **A write that changes nothing stays a no-op** — a patch with no other field than the row's key (or the row's own timestamp fields) runs no statement and keeps the stored time. A [versioned touch](/api/versioning#versioned-touch) (key + `$cas` only) and `touchMany` bump the version only.
- **Nested fields** — `audit.updatedAt` is set when the write carries `audit`: a replace always does, a patch only when it includes the object. In an array of objects every item is set, and every item an array patch adds or updates (`$insert`, `$upsert`, `$replace`, `$update`). An array without [`@expect.array.key`](/api/update-patch#keyed-object-arrays) matches `$upsert` and unique `$insert` items by their whole value, which then includes the new time, so such an item is always added — give the array a key. Below a tuple or a union of several object types the field is not set: the payload's value is stored and required.
- **Version-exempt patches** — the time is set but does not count as a write for [`@db.column.version.exempt`](/api/versioning#version-exempt): a patch that writes only exempt fields still keeps the version.
- **Validation** — the field may be omitted on replace (server and db-client), and on insert when it also has a default. `/meta` keeps the annotation so forms can show the field as server-managed.
- **MySQL** — with `@db.default.now` the column is a `TIMESTAMP`: the time is stored in whole seconds unless the field declares `@db.mysql.type "TIMESTAMP(3)"` (see [Fractional seconds](/adapters/mysql#fractional-seconds)).

`@db.onUpdate.now` requires a `number` field and cannot be combined with `@meta.id`, `@db.column.version`, `@db.encrypted` or `@db.column.derived`.

## Version Defaults

The [`@db.column.version`](/api/versioning) annotation implies a `0` default — you don't need to add `@db.default '0'` (and you shouldn't try to write the column directly anyway; see [Direct-write rejection](/api/versioning#direct-write-rejection)):

```atscript
@db.column.version
version: int
// Inserted rows get version = 0 automatically.
// SQL adapters emit DDL with NOT NULL DEFAULT 0 — ALTER TABLE backfills
// existing rows when the column is added later.
// Mongo writers inject version: 0 at insert when the field is missing.
```

Every successful write thereafter increments the column by `1`, server-side. See [Optimistic Concurrency (Row Versioning)](/api/versioning) for the full feature.

## How Defaults Interact with Inserts

Understanding when defaults apply:

- **Omitted fields** — the default value is used. This is the primary use case.
- **`undefined` values ≡ omitted** (since 0.1.128) — a key whose value is `undefined` is dropped before defaults and validation run, at every nesting depth, so `{ cap: undefined }` gets the default exactly like leaving `cap` out. Before 0.1.128 SQL adapters bound it as `NULL` (a constraint error on `NOT NULL` columns). `null` remains an explicit NULL.
- **Explicit values** — if you pass a value for a field with a default, your value takes precedence. The default is only a fallback.
- **Static defaults are filled SDK-side on every adapter** (since 0.1.128) — `@db.default 'x'` is written explicitly into the row before validation, also on SQL adapters whose DDL carries the same `DEFAULT` clause (writing the column's own default is equivalent to leaving it out). Rows therefore reach validators and [write guards](/api/crud#write-guards) complete. Function defaults (`@db.default.now` / `.uuid` / `.increment`) stay adapter-native: they are generated SDK-side only when the adapter does not handle them in the engine (see each adapter's page).
- **Optional fields without defaults** — become `NULL` if omitted from the insert.
- **Fields with `@db.default.increment`** — typically omitted from inserts entirely. The database generates the next value.
- **Fields of embedded objects** (since 0.1.155) — a default on `audit.at` is set inside `audit` when the row has an `audit` object; an absent or `null` embedded object stays absent: on PostgreSQL and MySQL, where `audit.at` is a column with the default in its DDL, an insert or replace without `audit` writes `NULL` into the object's columns, so the engine default does not make it appear. In an array of objects every item gets it, and inside a `@db.json` value (which has no column default) the SDK fills `now` / `uuid` on every adapter. Below a tuple or a union of several object types (`[A, B]`, `(A | B)[]`) the item a default belongs to is not known, so it is not filled, and the field is required on insert like a field without a default — by the server, by `@atscript/db-client` and by a form that validates against `/meta` with `@atscript/db/validator`.
- **Defaulted fields pass validation when omitted** — insert and replace validation (server and db-client) accept a row without a field that has a `@db.default*`, even when it is not optional (except below a tuple or a union of several types, see above). The TypeScript type still requires it unless it has `?` (next item).
- **Non-optional fields without defaults** — must always be provided. `@db.default` does not make a field optional in TypeScript — you still need `?` if you want to omit it from inserts.

```typescript
// Only 'title' is required — all other fields are optional (marked with ?)
await todos.insertOne({ title: "Learn Atscript" });

// Result:
// {
//   id: 1,                    ← @db.default.increment
//   title: 'Learn Atscript',
//   completed: false,         ← @db.default 'false' (field is optional with ?)
//   description: null,        ← optional, no default
//   createdAt: 1710500000000  ← @db.default.now
// }
```

## Next Steps

- [Indexes & Constraints](/api/indexes) — database indexes, precision, and collation
- [Tables & Fields](/api/tables) — declaring tables, primary keys, and field types
- [CRUD Operations](/api/crud) — insert, query, update, and delete data
