# Annotations Reference — @atscript/db-mongo

> All database and MongoDB-specific annotations available when using the mongo plugin.

## Annotation Namespaces

Annotations are split between core `@db.*` (database-generic) and `@db.mongo.*` (MongoDB-specific).

## Core `@db.*` Annotations

These come from `@atscript/core` and are used by the mongo plugin at runtime.

### `@db.table "name"` (interface-level)

Names the collection. **Required** for `AsCollection` to work.

```atscript
@db.table 'users'
export interface User {
    name: string
}
```

### `@db.index.plain "name?", "sort?"` (field-level, multiple)

Standard index. Fields sharing the same name form a compound index.

```atscript
@db.table 'products'
export interface Product {
    @db.index.plain 'cat_status'
    category: string

    @db.index.plain 'cat_status'
    status: string
}
```

### `@db.index.unique "name?"` (field-level, multiple)

Unique constraint index.

```atscript
@db.table 'users'
export interface User {
    @db.index.unique 'email_idx'
    email: string.email
}
```

### `@db.index.fulltext "name?"` (field-level, multiple)

Generic fulltext index (always weight 1 in MongoDB).

```atscript
@db.table 'articles'
export interface Article {
    @db.index.fulltext
    title: string
}
```

## MongoDB-Specific `@db.mongo.*` Annotations

### `@db.mongo.collection` (interface-level, no args)

Optional convenience annotation. When present, auto-injects `_id: mongo.objectId` if the interface doesn't define one. Validates that `_id` (if present) is not optional and is of type string, number, or mongo.objectId.

```atscript
@db.table 'users'
@db.mongo.collection
export interface User {
    // _id: mongo.objectId — auto-injected
    name: string
}
```

### `@db.mongo.autoIndexes true|false` (interface-level)

Toggle automatic index creation when `syncIndexes()` is called. Default: true.

### `@db.mongo.index.text weight?` (field-level)

MongoDB-specific text index with optional weight (number). Extends `@db.index.fulltext` with weight support.

```atscript
@db.table 'articles'
export interface Article {
    @db.mongo.index.text 10
    title: string

    @db.mongo.index.text 1
    body: string
}
```

### `@db.mongo.search.dynamic "analyzer?", fuzzy?` (interface-level)

Dynamic Atlas Search index.

### `@db.mongo.search.static "analyzer?", fuzzy?, "indexName?"` (interface-level, multiple)

Named static Atlas Search index.

### `@db.mongo.search.text "analyzer?", "indexName?"` (field-level, multiple)

Atlas Search text field mapping.

### `@db.mongo.search.vector dimensions, "similarity?", "indexName?"` (field-level)

Vector search index. Similarity: `"cosine"`, `"euclidean"`, or `"dotProduct"`.

```atscript
@db.table 'documents'
export interface Document {
    @db.mongo.search.vector 1536, "cosine", "vector_idx"
    embedding: mongo.vector
}
```

### `@db.mongo.search.filter "indexName"` (field-level, multiple)

Pre-filter field for vector search.

### `@db.mongo.patch.strategy "replace"|"merge"` (field-level)

Controls how nested objects and arrays are updated during patch operations. See [patches.md](patches.md) for details.

### `@db.mongo.array.uniqueItems` (field-level)

Enforces set-semantics on array `$insert` operations — duplicates are silently dropped.

```atscript
@db.table 'tags'
export interface TaggedItem {
    @db.mongo.array.uniqueItems
    tags: string[]
}
```

## Common Patterns

### Full collection definition

```atscript
@db.table 'users'
@db.mongo.collection
export interface User {
    @db.index.unique 'email_idx'
    email: string.email

    @db.mongo.index.text 5
    @expect.minLength 2
    name: string

    @db.index.plain 'status_idx'
    isActive: boolean

    @db.mongo.patch.strategy 'merge'
    profile: {
        bio?: string
        avatar?: string
    }

    @db.mongo.array.uniqueItems
    tags?: string[]
}
```
