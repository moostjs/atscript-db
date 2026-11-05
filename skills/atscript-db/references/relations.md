# relations

`@db.rel.FK` declares the foreign key. `@db.rel.to/.from/.via` declare navigation — loaded only when requested via `controls.$with`, filterable with `$some` / `$none` (0.1.147).

## Declaring an FK

```atscript
@db.table 'tasks'
interface Task {
    @meta.id
    id: number

    title: string

    @db.rel.FK
    ownerId: User.id                      // chain ref: type + relation info
}
```

Target must be a chain ref to a `@meta.id` field or a field marked `@db.index.unique`. Optional FKs use `?` — or `ownerId: User.id | null` (0.1.165; same optional FK, always present in the row type). Only `<chain ref> | null` is accepted: `User.id | string` is still the "requires a chain reference" error.

## Navigation annotations

| Annotation     | Cardinality | FK location                  |
| -------------- | ----------- | ---------------------------- |
| `@db.rel.to`   | N:1         | This table                   |
| `@db.rel.from` | 1:N         | Other table                  |
| `@db.rel.via`  | M:N         | Junction table holds two FKs |

```atscript
@db.table 'posts'
interface Post {
    @meta.id
    id: number

    @db.rel.FK
    authorId: User.id

    @db.rel.to
    author: User              // single target

    @db.rel.from
    comments: Comment[]     // other table's FK points here

    @db.rel.via PostTag
    tags: Tag[]      // junction table PostTag
}
```

### Aliases

`@db.rel.to 'assignee'` targets a specific FK when a table has multiple FKs to the same type:

```atscript
@db.rel.FK 'assignee'
assigneeId?: User.id

@db.rel.FK 'reporter'
reporterId: User.id

@db.rel.to 'assignee'
assignee?: User

@db.rel.to 'reporter'
reporter: User
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
- Others emulate via `ApplicationIntegrity`: reads the matching parents, counts children (restrict) / cascades / nulls inside the same transaction, then deletes them — by the filter again, or, when the filter / row scope holds a `$some` / `$none` (0.1.147), EXACTLY those parents by primary key (a `$some` over a cascaded child relation still deletes the parent; no PK → `REL_FILTER_NOT_SUPPORTED`).

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

Dotted names nest (0.1.165; ≤ 0.1.164 silently skipped): `$with: ["tasks.assignee"]` = `tasks` with `$with: [{ name: "assignee" }]`; the entry's own `filter` / `controls` apply at the LAST level; entries for the same relation merge (first entry's filter/controls win, nested lists concatenate); string shorthand works (`$with: ["tasks"]` used to throw). moost-db rewrites `?$with=a.b` into the nested form right after parsing, so checks, seals and row scopes run per level and an unknown segment answers `Unknown relation "b"`.

Adapters with `supportsNativeRelations(): true` can implement JOIN/`$lookup`-based loading; the default is an application-level batch-loader that fires one query per relation, independent of result-set size.

Controls are PER PARENT ROW (0.1.147, every adapter): `{ name: "comments", controls: { $sort: { createdAt: -1 }, $limit: 5 } }` = the 5 newest comments of EACH post. FROM / VIA: sort, then `$skip` / `$limit` per parent; VIA `$sort` orders the targets (no `$sort` → junction order); TO: `$skip ≥ 1` / `$limit: 0` → `null`. SQL reads a paged TO / FROM relation with a `ROW_NUMBER()` window → needs SQLite ≥ 3.25, MySQL ≥ 8.0 (MariaDB ≥ 10.2). ≤ 0.1.146 on SQL / memory: `$skip` / `$limit` paged ALL parents' rows together (`$limit: 1` → one parent got a row) and VIA ignored `$sort` (Mongo was already per parent for VIA).

Projections (0.1.143): a relation's sub-`$select` accepts array, inclusion-map and exclusion-map forms on every adapter (≤ 0.1.142 Mongo `$lookup` 500'd on the map forms); join keys are never dropped. A parent `$select` that omits the join key (TO: the FK; FROM / VIA: the PK) still loads the relation — the key is read for the join and stripped from the rows (≤ 0.1.142: `project: null`).

### Per-relation filter

`@db.rel.filter` hangs a permanent filter on a navigation:

```atscript
@db.rel.from
@db.rel.filter `status = 'open'`
openSubtasks: Task[]

@db.rel.via TicketLabel
@db.rel.filter `TicketLabel.pinned = true and Label.name != 'hidden'`
pinnedLabels: Label[]
```

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | APPLIED at run time since 0.1.147 on every adapter — in `$with` (ANDed with the `$with` entry `filter`) and in `$some` / `$none` predicates. ≤ 0.1.146 it was validated but IGNORED (`$with` loaded everything).                                                                                                                                                       |
| 2   | Expression syntax uses `and` / `or` / `not` keywords. Refs: the related type (unqualified = related type) and, on `via`, the junction.                                                                                                                                                                                                                                 |
| 3   | `via`: top-level `and` conditions split by side — related-type conditions filter targets, junction conditions filter links. One top-level condition reading BOTH sides (an `or` across them, or a parenthesized group) → compile error; a field-to-field comparison (any relation) → compile error (LSP-visible). Runtime still answers `INVALID_QUERY` as a backstop. |

## Filtering parents by related rows — `$some` / `$none` (0.1.147)

`{ ticket: { $some: { status: "open" } } }` / `{ issues: { $none: {} } }` — semantics, NULL-FK rule, limits, `$every` equivalent → [queries.md § Relational predicates](queries.md#relational-predicates--some--none-01147). A `$with` filter narrows the loaded children; a predicate narrows the parents.

`@db.rel.filterable` (flag, nav fields only; else diagnostic) = HTTP opt-in for CLIENT predicates on that relation (`ticket=$some(…)`). Server-side code (direct table calls, `transformFilter`, `actionRowScope`) never needs it. Not in the schema hash. `/meta.relations[].filterable: true`. Gate + overlay → [moost-db.md](moost-db.md#relational-predicates-over-http-01147).

```atscript
@db.rel.to
@db.rel.filterable
ticket?: Ticket
```

## Nested writes (depth-gated)

`@db.depth.limit N` on the **host table** enables nested inserts/replaces/patches into navigation arrays. Without it, nested payloads error out with HTTP 400.

```atscript
@db.table 'posts'
@db.depth.limit 2
interface Post {
    @meta.id
    id: number

    @db.rel.from
    comments: Comment[]
}
```

```ts
await posts.insertOne({
  id: 1,
  title: "...",
  comments: [{ body: "nested comment" }], // depth 1
});
```

Server runs nested writes in the same transaction as the parent; on failure the whole operation rolls back.

Nested-write key linking (0.1.169):

- **Insert linking** (TO / FROM / VIA): each FK field gets the field it REFERENCES in the row AS WRITTEN (after the write guard + defaults + TO phase); PK parts (generated ones included) from the inserted id. The payload's own FK value is OVERWRITTEN. Nested arrays are read after the guard (insert + replace, as patch). Was: unique-field FK got the row's id, composite FK unset, TO uuid-defaulted unique field unset (payload FK survived).
- **Fail closed** → `FK_VIOLATION`, checked before ANY write (TO phase included) when the referenced field is absent from the row — a non-key field only the DB fills (increment, native uuid/now) counts as absent. Exception: a generated PK part the insert does not report (SQLite composite increment, MySQL multi-row) is found after the insert → rolled back.
- **VIA existing target**: an entry with the target's WHOLE PK is linked by its STORED referenced value, read before any write (entry's own differing value → `INVALID_QUERY`; missing target → `FK_VIOLATION`; insert, replace and patch).
- **Every level is pre-checked (0.1.170)**: the root write runs, for the WHOLE tree, the checks each nested level would make on its turn — unresolvable links (`FK_VIOLATION`), missing existing VIA targets (`FK_VIOLATION`), FKs to missing rows (application-integrity adapters: memory, Mongo), replace shapes (`INVALID_QUERY`), depth overflow — before ANY write (TO phase included). EXCEPT FKs into tables the same call writes rows in (root, siblings, earlier batch items: the row may not exist yet) — checked when their level writes, so a missing row there can still leave upper levels written on memory / standalone Mongo. ≤ 0.1.169 only the root's own relations were checked first; a level-2/3 refusal came after the root (and level 1) were written — a partial write on memory / standalone Mongo.
- **No FK to this table = refused (0.1.170)**: nested data for a `@db.rel.from` whose child has no `@db.rel.FK` to THIS table (or a `@db.rel.via` whose junction lacks one) → `INVALID_QUERY` before any write (was: silently dropped). Typical cause: `interface B extends A` with another `@db.table` inherits A's FROM/VIA fields whose FKs reference A — compile warning on B's `@db.table`; `$with` of such a relation on B loads nothing.
- **Generated string parent key (0.1.170)**: FROM children of a parent whose key the DB generates (native `uuid`: PostgreSQL / MySQL) are pre-validated without the FK (was: a `0` stand-in → `Expected string` validation error, the insert failed).
- **Collation-aware key matching (0.1.170)**: VIA existing targets, VIA `$update`/`$upsert` link checks, FROM ownership and FROM replace orphans compare keys exactly first, then ask the DB on a miss — under a case-insensitive collation (MySQL default, `nocase`) `"ABC"` names stored `"abc"` (≤ 0.1.169: VIA → `INVALID_QUERY` / `FK_VIOLATION`, FROM replace DELETED the child as an orphan). Memory has no collation (code-point keys).
- **Keyed FROM children that are not stored (0.1.170)**: PUT arrays, `$replace` and `$upsert` entries whose PK names none of the parent's stored children (exact, or by the DB's collation) are INSERTED with that key (was: silently skipped — PUT returned `modifiedCount: 1`, the child was never stored). Composite keys holding the parent key (`orderId, lineNo`) included. A PK under ANOTHER parent stays `CONFLICT`. `$update` on a missing key stays a no-op.
- **Replace / patch limits**: FROM / VIA children only via a single-field FK to the parent PK (VIA: and to the target PK) → else `INVALID_QUERY` before any write (was: silently skipped for composite parents, PK written into a unique-field FK). Composite junction FKs → `INVALID_QUERY` (was skipped). Replace TO object must carry the referenced field (`INVALID_QUERY`). Patch addressed by a unique field: nested FROM/VIA written under the stored row's PK (was silently dropped).

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

`GET /meta` serializes the bound type with a fixed `refDepth: 0.5`, independent of `@db.depth.limit` (which governs write acceptance, not serialization). Each FK's `ref.type` is the shallow `{ id, metadata }` shape, carrying the target's `db.http.path` (its canonical route in the serving app; none when ambiguous) so clients can resolve the target endpoint for value-help pickers and lazy-fetch the target's own `/meta` when deeper structure is needed. Nav-prop trees (`@db.rel.from` / `@db.rel.to` / `@db.rel.via`) are not `.ref` nodes and always fully expand in meta regardless — the shape clients need to construct nested-insert payloads is always present.

**Terminal refs (since 0.1.128).** A prop declared through a reference chain — a view field `code: Issue.code` where `Issue.code: Dict.code` carries `@db.rel.FK`, or a table column / form field declared the same way — serializes with `ref` pointing at the chain's TERMINAL field (`{ field: 'code', type: { id: 'Dict', metadata } }`, still shallow) and gains `db.rel.FK: true` when any hop is an FK (the marker never travels through references at runtime — `passedWhenReferred: false`). Direct FKs and PK targets are unchanged; a chain that passes no FK is re-pointed but not marked; nav subtrees are left alone. Applies to `/meta` and `/meta/form/:name` on every readable controller (`applyTerminalRefs` / `resolveTerminalRef` are exported from `@atscript/moost-db`). The DB layer keeps the first hop (it is the source column); the runtime type is never mutated.

## Composite FK targets

When the target table has a composite PK, declare one FK per key column under the same alias — together they form one composite FK covering the whole key (a single column of a composite PK is a compile error unless it is `@db.index.unique`):

```atscript
@db.rel.FK 'order'
orderId: Order.id

@db.rel.FK 'order'
orderProductId: Order.productId
```

## Self-referential relations

```atscript
@db.table 'categories'
interface Category {
    @meta.id
    id: number

    @db.rel.FK
    parentId?: Category.id

    @db.rel.to
    parent?: Category

    @db.rel.from
    children: Category[]
}
```

## Value-help

`@db.rel.FK` on a **non-table** host (dictionaries, WF forms, bare interfaces) acts purely as a value-help indicator: the UI renders a picker whose URL is the target's published `@db.http.path` (its canonical controller route). All other rules still apply.
