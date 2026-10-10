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
| **Flattened** | Nested objects (default), unions of objects              | Each nested field → a `__`-separated column | Yes               |
| **JSON**      | `@db.json` objects, all arrays, mixed unions             | Entire value → single JSON column           | Adapter-dependent |
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

## Nullable and Union Fields {#unions}

Since 0.1.155 the storage of a union follows from its members. The rules apply on the SQL adapters (SQLite, PostgreSQL, MySQL); MongoDB and the in-memory adapter store the value as it is, with the same field paths for filters and sorts.

**`T | null` is stored like `T`, in a nullable column.** The column has the type `T` alone would get — its tags, `@expect.maxLength`, `@db.column.precision` and the field's own annotations included — and accepts `NULL`. The same holds for an alias of such a union (`export type MaybeCount = number.int | null`).

```atscript
qty: number.int | null                // → qty INTEGER (PostgreSQL), nullable
status: 'open' | 'closed' | null      // → status TEXT, nullable
tags: string[] | null                 // → tags JSON, nullable
address: Address | null               // → address__street, address__zip — all nullable
```

**An object that may be absent makes every column under it nullable.** This covers `address: Address | null` and an optional object (`shipping?: { street: string, city: string }`): `shipping__street` is nullable even though `street` is required, so a row can leave `shipping` out. A row whose columns under the object are all `NULL` reads back with the object as `null`. Setting the object to `null` in a patch sets all its columns to `NULL`.

**A union of objects is flattened like a nested object.** Each leaf of each member gets one `__` column, and the union field gets no column of its own:

```atscript
interface CardPayment {
    kind: 'card'
    card: string
    amount: number
}

interface BankPayment {
    kind: 'bank'
    iban: string
    amount: number
    bic?: string
}

payment: CardPayment | BankPayment
```

| Column            | Nullable | Why                                     |
| ----------------- | -------- | --------------------------------------- |
| `payment__kind`   | no       | required in every member                |
| `payment__card`   | yes      | only `CardPayment` declares it          |
| `payment__amount` | no       | required in every member                |
| `payment__iban`   | yes      | only `BankPayment` declares it          |
| `payment__bic`    | yes      | optional, and only `BankPayment` has it |

- A leaf that several members declare with the same type shares one column. It is `NOT NULL` only when every member declares it as required.
- `| null` on the union (`refund: CardPayment | BankPayment | null`) makes every column nullable, and a `NULL` row reads back as `refund: null`.
- Reads return only the stored member's fields: a field that only some members declare is left out when its column is `NULL` (a card payment reads back without `iban` and `bic`).
- Filter, sort and `$select` with dot paths, as for any nested object: `{ "payment.card": "4111" }`, `$sort: { "payment.amount": -1 }`, `$select: ["payment"]`.
- Writing another member (insert, replace, or a patch of `payment`) sets the other member's columns to `NULL`. On MongoDB the stored object is replaced as a whole.

### Null tests on an object {#object-null-tests}

Since 0.1.155 `{ address: null }`, `{ address: { $ne: null } }` and `{ address: { $exists: true | false } }` work on any stored object — `| null`, optional, a union of objects or a plain nested object, not inside a `@db.json` value — on every adapter, over HTTP too (`?address=null`, `?address!=null`). The object counts as null when none of its fields holds a value, which is what an all-`NULL` row reads back as on the SQL adapters. On MongoDB and the in-memory adapter an object stored as `{}`, or with only `null` fields, therefore counts as null too. Other comparisons, and sorting, on the whole object stay rejected; compare its fields instead. Over HTTP the test is accepted only while every field of the object is visible to the caller and takes an `$exists` filter itself (none is `@db.writeOnly` or `@db.encrypted`); the object itself stays unlisted in `/meta.fields`, like every object parent.

### Same-name leaves and mixed unions

**Same-name leaves of different types.** When the members' leaves are scalars of different types (`{ x: number } | { x: string }`), `x` is one text column, like a `string | number` field. When one of them is an object or an array, that leaf is one JSON column.

**A union that mixes an object with another type is one JSON column.** `extra: Address | string` (or `Address | Address[]`) has no column layout of its own, so it is stored like a `@db.json` field: one JSON column, nullable with `| null`, read back as the stored object or string. As with `@db.json`, paths inside it cannot be filtered or sorted on the SQL adapters. Tuples (`[number, string]`) are JSON columns too, like arrays.

**Unions of scalars** keep one column: of their common type when every member has the same one (`'a' | 'b'`, `string.email | string.uuid`), otherwise a text column (`string | number`).

::: warning Changed in 0.1.155
Earlier versions stored most unions in one text column (`NOT NULL` unless the field was optional), and added unused dot-named columns (`payment.card`) for an object member. The first schema sync after the upgrade moves the values into the new columns — see [Upgrading](/guide/upgrading#v0-1-155-json-copy).
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
