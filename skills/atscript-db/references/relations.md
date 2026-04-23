# relations

`@db.rel.FK` declares the foreign key. `@db.rel.to/.from/.via` declare navigation — loaded only when requested via `controls.$with`.

## Declaring an FK

```atscript
@db.table 'tasks'
interface Task {
    @meta.id id: number
    title: string

    @db.rel.FK
    ownerId: User.id                      // chain ref: type + relation info
}
```

Target must be a chain ref to a `@meta.id` field or a field marked `@db.index.unique`. Optional FKs use `?`.

## Navigation annotations

| Annotation     | Cardinality | FK location                  |
| -------------- | ----------- | ---------------------------- |
| `@db.rel.to`   | N:1         | This table                   |
| `@db.rel.from` | 1:N         | Other table                  |
| `@db.rel.via`  | M:N         | Junction table holds two FKs |

```atscript
@db.table 'posts'
interface Post {
    @meta.id id: number

    @db.rel.FK authorId: User.id
    @db.rel.to author: User              // single target

    @db.rel.from comments: Comment[]     // other table's FK points here
    @db.rel.via PostTag tags: Tag[]      // junction table PostTag
}
```

### Aliases

`@db.rel.to 'assignee'` targets a specific FK when a table has multiple FKs to the same type:

```atscript
@db.rel.FK 'assignee' assigneeId?: User.id
@db.rel.FK 'reporter' reporterId: User.id
@db.rel.to 'assignee'  assignee?: User
@db.rel.to 'reporter'  reporter: User
```

## Referential actions

`@db.rel.onDelete` / `@db.rel.onUpdate` accept:

| Action         | Effect                                   |
| -------------- | ---------------------------------------- |
| `'cascade'`    | Propagate delete/update to children.     |
| `'restrict'`   | Reject if children exist.                |
| `'noAction'`   | DB default.                              |
| `'setNull'`    | Set FK to NULL (field must be optional). |
| `'setDefault'` | Set FK to its `@db.default` value.       |

- Adapters with `supportsNativeForeignKeys(): true` push this to the DB.
- Others emulate via `ApplicationIntegrity`: counts children before delete, runs cascade updates inside the same transaction.

## Loading — `controls.$with`

```ts
await tasks.findMany({ controls: { $with: [{ name: "project" }] } });
await tasks.findMany({
  controls: {
    $with: [
      { name: "project" },
      { name: "assignee", controls: { $select: ["id", "name"] } },
      { name: "tags" }, // M:N via junction
    ],
  },
});
```

Adapters with `supportsNativeRelations(): true` can implement JOIN/`$lookup`-based loading; the default is an application-level batch-loader that fires one query per relation, independent of result-set size.

### Per-relation filter

`@db.rel.filter` hangs a permanent filter on a navigation:

```atscript
@db.rel.from
@db.rel.filter `status = 'open'`
openSubtasks: Task[]
```

## Nested writes (depth-gated)

`@db.deep.insert N` on the **host table** enables nested inserts/replaces/patches into navigation arrays. Without it, nested payloads error out with HTTP 400.

```atscript
@db.table 'posts'
@db.deep.insert 2
interface Post { @meta.id id: number, @db.rel.from comments: Comment[] }
```

```ts
await posts.insertOne({
  id: 1,
  title: "...",
  comments: [{ body: "nested comment" }], // depth 1
});
```

Server runs nested writes in the same transaction as the parent; on failure the whole operation rolls back.

## Fractional ref depth on `/meta`

The `GET /meta` endpoint serializes the bound type with `refDepth: (@db.deep.insert N) + 0.5`. The `+0.5` signals to the client that the terminal FK target is expanded **as a shallow ref**, not a full nested object. Clients can count frames on serialized annotated types and match the server's acceptance envelope exactly.

## Composite FK targets

When the target table has a composite PK, chain refs span the composite:

```atscript
@db.rel.FK orderRef: OrderLine.order_product_key    // composite-key unique index name
```

## Self-referential relations

```atscript
@db.table 'categories'
interface Category {
    @meta.id id: number
    @db.rel.FK parentId?: Category.id
    @db.rel.to parent?: Category
    @db.rel.from children: Category[]
}
```

## Value-help

`@db.rel.FK` on a **non-table** host (dictionaries, WF forms, bare interfaces) acts purely as a value-help indicator: the UI renders a picker whose URL is the target's `@db.http.path`. All other rules still apply.
