---
outline: deep
---

# Defaults & Generated Values

<!--@include: ../_experimental-warning.md-->

Atscript lets you set default values directly in your `.as` schema. Defaults ensure fields are populated automatically on insert — you define them once, and every adapter handles the rest.

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

Timestamps use `number` (epoch milliseconds) rather than a `Date` type — this is deliberate. Numbers are JSON-native, so timestamps pass through HTTP boundaries (client ↔ server) without any serialization or hydration step. A `Date` type would require walking every response to convert strings back to `Date` instances on both sides.

::: tip Semantic Types Include Defaults
Semantic types like `number.timestamp.created` already include `@db.default.now` — you don't need to add it manually:

```atscript
// Concise — semantic type handles the default
createdAt?: number.timestamp.created

// Equivalent verbose form
@db.default.now
createdAt?: number
```

:::

## How Defaults Interact with Inserts

Understanding when defaults apply:

- **Omitted fields** — the default value is used. This is the primary use case.
- **Explicit values** — if you pass a value for a field with a default, your value takes precedence. The default is only a fallback.
- **Optional fields without defaults** — become `NULL` if omitted from the insert.
- **Fields with `@db.default.increment`** — typically omitted from inserts entirely. The database generates the next value.
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
