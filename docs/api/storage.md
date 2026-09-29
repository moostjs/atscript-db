---
outline: deep
---

# Storage & Nested Objects

<!--@include: ../_experimental-warning.md-->

Atscript fields can be stored in the database in three different ways. Understanding these storage modes is key to designing queryable, efficient schemas.

## Three Storage Modes

| Mode          | Applies To                                               | What Happens                                | Queryable?        |
| ------------- | -------------------------------------------------------- | ------------------------------------------- | ----------------- |
| **Column**    | Scalar fields (`string`, `number`, `boolean`, `decimal`) | One field → one database column             | Yes               |
| **Flattened** | Nested objects (default)                                 | Each nested field → a `__`-separated column | Yes               |
| **JSON**      | `@db.json` objects, all arrays                           | Entire value → single JSON column           | Adapter-dependent |
| **Derived**   | `@db.column.derived` fields                              | One leaf of a JSON field → its own column   | Yes               |

## Column Storage

Scalar fields map directly to database columns — one field, one column. This is the default behavior for all scalar types and requires no annotation:

```atscript
@db.table 'users'
export interface User {
    @meta.id
    id: number

    name: string       // → column: name
    email: string      // → column: email
    active: boolean    // → column: active
}
```

## Flattened Storage

By default, nested objects are **flattened** into separate columns using `__` (double underscore) as a separator:

```atscript
@db.table 'profiles'
export interface Profile {
    @meta.id
    id: number

    name: string

    contact: {
        email: string
        phone?: string
    }
}
```

This creates four columns: `id`, `name`, `contact__email`, and `contact__phone`. When you read data back, the flat columns are automatically reconstructed into the nested object structure.

### Deep Nesting

Flattening works recursively at any depth:

```atscript
settings: {
    notifications: {
        email: boolean
        sms: boolean
    }
}
// Columns: settings__notifications__email, settings__notifications__sms
```

### Querying Flattened Fields

Flattened fields are real database columns — you can filter and sort on them using dot notation. The path is translated to the physical column name automatically:

```typescript
const results = await profiles.findMany({
  filter: { "contact.email": "alice@example.com" },
});
// Translates to: WHERE contact__email = 'alice@example.com'
```

::: tip
Flattened fields give you the best of both worlds: you work with nested objects in your code, but each field is a real, indexed, queryable column in the database.
:::

## JSON Storage

Use `@db.json` to store a nested object as a single JSON column instead of flattening it:

```atscript
@db.json
preferences: {
    theme: string
    lang: string
    shortcuts: string[]
}
// Single column: preferences (stored as JSON string in SQLite, JSONB in PostgreSQL, native object in MongoDB)
```

When to use `@db.json`:

- **Complex objects** you don't need to query by individual sub-fields
- **Dynamic or loosely-structured data** where flattening creates too many columns
- **Highly nested structures** where deep flattening is impractical

::: tip
Arrays are always stored as JSON regardless of `@db.json`. You only need the annotation for plain objects you want to keep as a single column.
:::

## Derived Columns

Since 0.1.141 a `@db.column.derived` field promotes **one scalar leaf** of a `@db.json` field of the same table to a real column of its own — filterable, sortable, groupable and indexable like any column, while the JSON value stays the single source of truth. The field's type is a chain reference into the JSON field:

```atscript
@db.table 'orders'
export interface Order {
    @meta.id
    id: number

    @db.json
    payload: {
        customer: {
            id: string
            vip: boolean
            tier?: string
        }
        total: number
    }

    @db.column.derived
    @db.index.plain
    customerId: Order.payload.customer.id

    @db.column.derived
    vip?: Order.payload.customer.vip

    @db.column.derived
    @db.column.collate 'nocase'
    tier?: Order.payload.customer.tier
}
```

The column holds the **declared** type, or `null` when the path is missing, the JSON value is `null`, or it has another JSON type — the same rules as a view's [JSON leaf](/views/#reading-json-leaves), with no coercion (`"14"` is not a number, `1` is not `true`). A path that may be absent (an optional step, or an optional leaf) should be declared optional (`tier?:`) — the compiler warns otherwise.

**What the compiler checks** (each is an error in the editor and at build time):

| Rule                                                                 | Message                                                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Only a top-level field of a `@db.table` interface                    | `@db.column.derived is only valid on a top-level field of a @db.table interface`                                     |
| The type is a chain reference (`Order.payload.customer.id`)          | `@db.column.derived requires a chain reference into a @db.json field of the same table …`                            |
| … into the **same** table                                            | `@db.column.derived must reference the enclosing table 'Order', not 'Customer' — a derived column reads its own row` |
| … that descends into a `@db.json` field                              | `… does not read inside a @db.json field — a flattened or scalar column needs no derived column`                     |
| No array on the path                                                 | `… crosses an array — a derived column reads one scalar leaf`                                                        |
| Not inside a `@db.encrypted` field                                   | `… reads inside a @db.encrypted field — ciphertext cannot be extracted`                                              |
| The leaf is a `string`, `number` or `boolean`                        | `… must end at a string, number or boolean leaf (got 'decimal')`                                                     |
| Not combined with an annotation that needs a stored, writable column | `@db.column.derived cannot coexist with @<name> — <why>`                                                             |

The last rule covers `@meta.id`, `@db.rel.FK`, `@db.default*`, `@db.column.version`, `@db.encrypted`, `@db.json`, `@db.ignore`, `@db.writeOnly`, `@db.index.fulltext` / `.geo`, `@db.search.vector` and the MongoDB search annotations. `@db.column`, `@db.column.renamed`, `@db.column.collate`, `@db.index.plain` / `.unique`, `@db.column.dimension` / `.measure` / `.filterable` / `.sortable` / `.searchable` and `@expect.*` are allowed.

**Reads and writes.** Every read fills the derived field; an inclusion `$select` of a derived field does not pull its JSON source along. A value supplied for a derived field on insert, replace or patch is **dropped silently** — the column is computed, never written — and a field operation on it (`$inc` / `$dec` / `$mul`) is a validation error (HTTP 400): patch the source leaf instead. `/meta.fields[path].derived` is `true` for such a field.

**Per adapter** — each adapter page has the DDL, the type guard and the introspection details:

| Adapter                                                                                | Storage                                                                             |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [SQLite](/adapters/sqlite#derived-columns)                                             | `GENERATED ALWAYS AS (…) VIRTUAL` — computed on read                                |
| [MySQL / MariaDB](/adapters/mysql#derived-columns)                                     | `GENERATED ALWAYS AS (…) VIRTUAL` — a string leaf is `VARCHAR(255)`                 |
| [PostgreSQL](/adapters/postgresql#derived-columns)                                     | `GENERATED ALWAYS AS (…) STORED` — computed on write                                |
| [MongoDB](/adapters/mongodb#schema-sync-notes), [memory](/adapters/memory#schema-sync) | Nothing is stored: the derived name maps to its source path (`payload.customer.id`) |

Adding, changing or removing a derived column is a schema-sync operation — see [What Gets Synced → Derived Columns](/sync/what-gets-synced#derived-columns).

## Queryability

The storage mode determines what you can query:

**Flattened fields** are fully queryable — they are real columns with their own types, indexes, and constraints. You can filter, sort, and index them like any other field.

**JSON fields** have limited, adapter-dependent queryability — see your
[adapter docs](/adapters/) for the specifics. Since 0.1.128 the limit is enforced rather than discovered in the database: on SQL adapters a descendant path of a `@db.json` / array column (`preferences.theme`) in a filter, `$sort`, `$select`, `$groupBy` or aggregate field throws `DbError("INVALID_QUERY")` (HTTP 400) before any SQL is built, and `/meta.fields` does not list it — select the parent and read the value client-side. MongoDB and the memory adapter address such paths natively (listed and queryable; never sortable as a whole column). Encrypted objects behave like JSON: select the encrypted parent.

::: info
If you need to filter on a field, prefer flattened storage (the default for objects). Use `@db.json` only when you treat the object as an opaque blob that is read and written as a whole.
:::

## Example: Same Schema, Different Storage

Consider a `Product` type with two nested objects — one flattened, one stored as JSON:

```atscript
@db.table 'products'
export interface Product {
    @meta.id
    id: number

    name: string

    // Flattened (default) — each field becomes a column
    dimensions: {
        width: number
        height: number
        weight: number
    }

    // JSON — stored as a single column
    @db.json
    metadata: {
        tags: string[]
        attributes: { key: string, value: string }[]
    }
}
```

This produces the following database columns:

| Column               | Source              | Storage Mode |
| -------------------- | ------------------- | ------------ |
| `id`                 | `id`                | Column       |
| `name`               | `name`              | Column       |
| `dimensions__width`  | `dimensions.width`  | Flattened    |
| `dimensions__height` | `dimensions.height` | Flattened    |
| `dimensions__weight` | `dimensions.weight` | Flattened    |
| `metadata`           | `metadata`          | JSON         |

You can filter on `dimensions.width` (it's a real column), but querying inside `metadata` requires adapter-specific JSON functions.

## Next Steps

- [Defaults & Generated Values](/api/defaults) — auto-generated values and static defaults
- [Indexes & Constraints](/api/indexes) — database indexes, precision, and collation
- [Field Encryption](/api/encryption) — `@db.encrypted` fields bypass these modes and store as one opaque text column
- [Tables & Fields](/api/tables) — declaring tables, primary keys, and field types
