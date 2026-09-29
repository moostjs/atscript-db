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

Projections (0.1.143): a relation's sub-`$select` accepts array, inclusion-map and exclusion-map forms on every adapter (≤ 0.1.142 Mongo `$lookup` 500'd on the map forms); join keys are never dropped. A parent `$select` that omits the join key (TO: the FK; FROM / VIA: the PK) still loads the relation — the key is read for the join and stripped from the rows (≤ 0.1.142: `project: null`).

### Per-relation filter

`@db.rel.filter` hangs a permanent filter on a navigation:

```atscript
@db.rel.from
@db.rel.filter `status = 'open'`
openSubtasks: Task[]
```

## Nested writes (depth-gated)

`@db.depth.limit N` on the **host table** enables nested inserts/replaces/patches into navigation arrays. Without it, nested payloads error out with HTTP 400.

```atscript
@db.table 'posts'
@db.depth.limit 2
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

### Nested-write integrity (0.1.143)

A nested write only touches rows related to the record being written. Every rule below is checked as a planning step BEFORE the call's first write (one read per relation for the whole batch) → a rejection never leaves a partial write, even without transactions (memory, standalone Mongo). Planned FROM children are then written through filters pinned to their parent (`{ pk, fk: parentPK }`) — a child re-parented between plan and write matches nothing → `CONFLICT`, rolled back (no in-phase re-checks).

| Payload                                                                             | Rule                                                                                                                                                                                | Violation                                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| FROM `$update` / `$upsert` / `$replace` by child PK; `replaceOne` with a FROM array | Only THIS record's children. A PK under another parent (or an orphan) is never re-parented / overwritten; `$replace` never deletes or steals.                                       | `CONFLICT` (409), path = relation               |
| FROM `$update` entry                                                                | Must carry the child PK.                                                                                                                                                            | `NOT_FOUND` (400), path `<rel>.$update[i].<pk>` |
| VIA `$update` / `$upsert` with target PK                                            | Target must ALREADY be linked. **Breaking:** `$upsert` by PK no longer creates the link — link an existing target with `$insert`. `$upsert` without PK still inserts + links.       | `CONFLICT` (409), no link created               |
| TO object on PATCH                                                                  | Patches the row the STORED FK references (read inside the tx). FK `null` → `FK_VIOLATION`.                                                                                          | —                                               |
| TO object + a changed FK in the same payload                                        | Rejected — re-point first, patch in a second call. Sending the unchanged FK value is fine.                                                                                          | `INVALID_QUERY` (400), path = FK field          |
| TO object whose own key names another row (`author: { id: 2 }`)                     | Rejected.                                                                                                                                                                           | `INVALID_QUERY` (400), path `<rel>.<pk>`        |
| Any nested phase                                                                    | Runs only for rows the main write MATCHED — missing row or stale `$cas` → no TO / FROM / VIA writes. **Breaking:** TO patch on a missing row → `{ matchedCount: 0 }` (was a throw). | —                                               |

- Unchanged by design: TO replace, VIA `$insert`, VIA plain-array replace by PK may reference (TO / VIA replace: overwrite) any row by key — authorizing that is the permission layer's job.
- Nested re-entries get neither `guard`, `check` nor `isFieldVisible` ([crud.md](crud.md#post-write-check-check-01143)); only the table's own integrity rules. A permission layer that must authorize related tables rejects nested payloads up front.

## Meta FK ref shape

`GET /meta` serializes the bound type with a fixed `refDepth: 0.5`, independent of `@db.depth.limit` (which governs write acceptance, not serialization). Each FK's `ref.type` is the shallow `{ id, metadata }` shape, carrying the target's `db.http.path` so clients can resolve the target endpoint for value-help pickers and lazy-fetch the target's own `/meta` when deeper structure is needed. Nav-prop trees (`@db.rel.from` / `@db.rel.to` / `@db.rel.via`) are not `.ref` nodes and always fully expand in meta regardless — the shape clients need to construct nested-insert payloads is always present.

**Terminal refs (since 0.1.128).** A prop declared through a reference chain — a view field `code: Issue.code` where `Issue.code: Dict.code` carries `@db.rel.FK`, or a table column / form field declared the same way — serializes with `ref` pointing at the chain's TERMINAL field (`{ field: 'code', type: { id: 'Dict', metadata } }`, still shallow) and gains `db.rel.FK: true` when any hop is an FK (the marker never travels through references at runtime — `passedWhenReferred: false`). Direct FKs and PK targets are unchanged; a chain that passes no FK is re-pointed but not marked; nav subtrees are left alone. Applies to `/meta` and `/meta/form/:name` on every readable controller (`applyTerminalRefs` / `resolveTerminalRef` are exported from `@atscript/moost-db`). The DB layer keeps the first hop (it is the source column); the runtime type is never mutated.

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
