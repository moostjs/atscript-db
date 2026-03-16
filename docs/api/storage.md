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

## Queryability

The storage mode determines what you can query:

**Flattened fields** are fully queryable — they are real columns with their own types, indexes, and constraints. You can filter, sort, and index them like any other field.

**JSON fields** have limited and adapter-dependent queryability:

| Adapter    | JSON Query Support                                       |
| ---------- | -------------------------------------------------------- |
| SQLite     | Limited — `json_extract()` via raw queries               |
| PostgreSQL | JSONB operators and indexing                             |
| MySQL      | JSON functions                                           |
| MongoDB    | Native nested query syntax (objects are stored natively) |

See [Adapters](/adapters/) for adapter-specific details on JSON querying.

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
- [Tables & Fields](/api/tables) — declaring tables, primary keys, and field types
