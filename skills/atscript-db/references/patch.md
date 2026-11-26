# patch

Decompose patch payloads into: scalar sets, field ops (`$inc`/`$dec`/`$mul`), array ops, merge-strategy object sets. SQL adapters emit `UPDATE … SET col = ?`; MongoDB emits a `$set` aggregation pipeline via `CollectionPatcher`.

## Field ops

```ts
import { $inc, $dec, $mul } from "@atscript/db/ops";

await posts.updateOne({ id: 1, views: $inc() }); // +1 atomic
await products.updateOne({ id: 42, stock: $dec(5) });
await products.updateOne({ id: 42, price: $mul(1.1) });
await users.updateMany({ status: "active" }, { points: $inc(100) });
```

Operands must be finite numbers (since 0.1.148): `$inc(NaN)`, `$dec(Infinity)`, `$mul(-Infinity)` fail validation with `Field operation operand must be a finite number, got <n>` (HTTP 400) instead of poisoning the stored value.

| Helper      | SQL                 | MongoDB          |
| ----------- | ------------------- | ---------------- |
| `$inc(n=1)` | `SET col = col + ?` | `$inc`           |
| `$dec(n=1)` | `SET col = col - ?` | `$inc` (negated) |
| `$mul(n)`   | `SET col = col * ?` | `$mul`           |

The `separateFieldOps()` helper strips these from the data payload before regular value handling. Mix with scalar assignments freely.

`undefined` props (since 0.1.128): pruned at every plain-object depth before decomposition — never `SET col = NULL`; `null` is the explicit NULL (optional columns; the readable's filter types admit `null` for them as well — `queries.md § Null values`). `{ $inc: undefined }` prunes to `{}` and fails validation like `{}` would. Empty patch → no statement (see `crud.md`).

## Typing (0.1.168)

`DbPatch<Row>` (update payloads; `PatchOf<T>` in db-client) types top-level ops: number field → `n | TDbFieldOp` (`{ $inc | $dec | $mul: n }`), array field → `A | TDbArrayOps<E>` (`$replace/$insert/$upsert: E[]`, `$update/$remove: Partial<E>[]` or the values for primitive arrays), payload → `$cas?`. Op on another type = type error. `DbInsert<Row>` (inserts) has no ops and no `$cas`. Types cannot see `@db.json` (ops there are a runtime 400, code `ARRAY_OP_ON_JSON` since 0.1.175 — client preflight too; send the whole array). Nested merge-strategy ops are untyped (cast). No `Record<string, unknown>` index signature → interface values fit; untyped table → `object`. `DbInsert` is all-optional: it does not catch missing required or server-set fields (validation does).

## Array ops

```ts
import { $replace, $insert, $upsert, $update, $remove } from "@atscript/db/ops";

await users.updateOne({
  id: 1,
  tags: $insert(["new"]), // append
  addresses: $upsert([{ id: "home", street: "..." }]), // key-match or append
  devices: $update([{ id: "phone", lastSeen: now }]), // key-match, update only — replaces the element unless `@db.patch.strategy 'merge'`
  permissions: $remove([{ role: "guest" }]), // key-match, remove
  preferences: $replace([{ theme: "dark" }]), // overwrite the whole array
});
```

Key-based ops (`$upsert`, `$update`, `$remove`) require `@expect.array.key` on the element's key field so the patcher knows what to match on. `@expect.array.uniqueItems` → `$insert` skips items already stored; `@db.patch.strategy 'merge'` on a keyed array → `$upsert` / `$update` of a matching element merges into it (else replaces: omitted optional fields are removed). `$update` follows the strategy on EVERY adapter since 0.1.180 (≤ 0.1.179: SQLite / MySQL / PostgreSQL / memory always merged; MongoDB already replaced). Same patch → same array on every adapter since 0.1.180: keyed `$insert` SKIPS an item whose key is stored (≤ 0.1.179: MongoDB replaced it, the others appended a duplicate key unless `uniqueItems`); keyed `$upsert` changes the element in place (MongoDB ≤ 0.1.179 moved it to the end); key-less `$remove` / `$upsert` / unique `$insert` keep the other elements' order and duplicates (MongoDB ≤ 0.1.179: set operations that deduplicated the stored array). Key-less object elements are compared whatever their property order, at every depth, on EVERY adapter (MongoDB since 0.1.182, any supported server; an item prop name with `.`, a leading `$` or empty → `$getField`, MongoDB ≥ 5.0 — ≤ 0.1.181 it compared embedded documents in stored property order: a re-ordered `$remove` item matched nothing, `$upsert` / unique `$insert` appended a copy; PG `JSONB` / MySQL `JSON` re-order keys — ≤ 0.1.179 `$remove` of a stored object matched nothing there); arrays inside an element compare in order; a missing prop ≠ `null`. Key-less `$upsert` / unique `$insert` of an equal item keeps the stored element as stored, an appended item is stored as sent (0.1.182; ≤ 0.1.181 key-less `$upsert` on SQLite / memory replaced the element with the item → item's property order). A null array + an op with nothing to apply stays null (0.1.180; SQL / memory wrote `[]`). `$update` never inserts; same-key items apply in order; no key props → no-op (MongoDB ≤ 0.1.179: set union). Ops of one field apply remove → update → upsert → insert on every adapter (MongoDB ≤ 0.1.179 ran update last). `updateMany` + `$insert` / `$upsert` / `$update` / `$remove` → applied to EACH matched row's own stored array, every row = what `updateOne` gives it (0.1.182 — rules below; 0.1.180 – 0.1.181 threw `INVALID_QUERY`; ≤ 0.1.179 unknown-column error on SQL, `{ "__$insert": [...] }` stored on memory / MongoDB). `$replace` stands alone: ops sent with it are ignored (MongoDB ≤ 0.1.179 applied them to the new array). MongoDB 0.1.180 fixes: `$`-prefixed strings in op items are stored as sent (≤ 0.1.179 read as field paths → could copy another field's value, SECURITY); ops on an array inside a replace-strategy nested object are applied (were stored as data); an op with an empty item list alone no longer throws `Update document requires atomic operators`.

Read-modify-write (every adapter but MongoDB, which patches natively; one transaction: read row → apply ops → write the whole array):

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The stored array is decoded as a read decodes it (0.1.178) — a SQLite sqlite-vec vector (Float32 `BLOB`) is patched as its numbers and stored back as JSON text ([adapters-sqlite.md](adapters-sqlite.md)).                                                                                                                                                                                                                                          |
| 2   | Stored value not an array (JSON text of a string / object written by raw SQL) → throws `Cannot apply array patch operators to "<column>": its stored value is not an array` (physical column: `box__labels`, the `@db.column` name), nothing written (0.1.178; before: spread item by item, a string into characters). `null` / missing = `[]`.                                                                                                      |
| 3   | `uniqueItems` and the merge strategy apply to arrays renamed with `@db.column` and inside flattened nested objects too (0.1.178; before: `$insert` stored duplicates, `$upsert` replaced instead of merging there).                                                                                                                                                                                                                                  |
| 4   | The read locks the row (`SELECT … FOR UPDATE` on PostgreSQL / MySQL, when `supportsReadLocks()`) — 0.1.182: concurrent op patches of one row run one after the other (≤ 0.1.181 READ COMMITTED could lose one). SQLite already serialised writers; memory: a `lock: 'update'` read takes the adapter's one in-process lock until the outermost scope ends (0.1.182), so concurrent op patches in one process do not lose changes; MongoDB unchanged. |
| 5   | Arrays inside nested objects take ops at any depth on every adapter. Memory since 0.1.182 = SQLite result (≤ 0.1.181: replace-strategy parent stored `{ $insert: [...] }` as the array, merge-strategy parent dropped stored items). Replace-strategy parent → omitted optional children `null`; merge parent → kept. A merge object INSIDE a replaced one stays merge (see `@db.patch.strategy` below).                                             |

`updateMany` with array ops (0.1.182; docs: `/api/update-patch#array-ops-update-many`):

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | MongoDB: ONE `updateMany` with the `updateOne` pipeline — every patch with `$insert/$upsert/$update/$remove`, or writing a field inside an embedded object — a nested `$replace`, a merge object, a field op in one (0.1.183; ≤ 0.1.182 a plain update: threw `Cannot create field … in element {…: null}` on an object stored as `null`, set a merge object's replaced parent whole) (per `_id` batch under relational predicates). Plain top-level sets, a top-level `$replace` (a plain set of the array; ≤ 0.1.182 it took the pipeline, same stored array), whole replaced objects → plain `updateMany`. A patch that sets nothing (empty item list, no version column) → no update, honest `matchedCount`. |
| 2   | SQLite / PostgreSQL / MySQL / memory: matched PKs read first (PK order; `FOR UPDATE` on PG / MySQL — rows locked to commit), then each row's patched arrays (also `FOR UPDATE`: a plain read would return a caller's older REPEATABLE READ snapshot), then ONE `UPDATE … WHERE <pk>` PER ROW — all in one transaction (caller's joined): a failing row rolls back the call (memory: no rollback). The row set is picked once, before any write. Large match sets → loop a bounded write.                                                                                                                                                                                                                         |
| 3   | Table without a primary key → `INVALID_QUERY` on those adapters (path = the field) — use `updateOne` / `bulkUpdate`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | `matchedCount` / `modifiedCount` = sum of the row writes, counted as a plain `updateMany` counts on that adapter; a row deleted between pick and write is not counted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | Bounded `{ limit, sort }` works on every adapter: keys picked first, then rows patched as above (MySQL / PG / SQLite native `LIMIT` statements are not used for such a patch).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6   | Plain sets / `$inc` in the same patch hit every row; version +1 per row unless only exempt fields; `$cas` still → `INVALID_QUERY`. Custom native-patch adapters: optional `nativePatchMany` ([creating-adapters.md](creating-adapters.md)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Item validation (since 0.1.153) = plain-array-set validation: optional item fields accept `null` in `$update`; errors name the item prop (`items.$update[0].qty`, `tags.$remove[1]`); primitive `$remove`/`$update` values are checked per element (array-level `@expect.minLength` no longer applies to the payload). `$inc`/`$dec`/`$mul` inside any array item (plain set, `$insert`, `$upsert`, `$update`) → validation error (used to be stored verbatim).

Operator items are `@normalize.*`-normalized before validation (0.1.170), `$update`/`$remove` keys included — `$remove: [" RED "]` removes the stored `"red"` on a lowercasing+trimming element type. See [validation.md § Normalization](validation.md#normalization-normalize-01170).

## `@db.patch.strategy`

Per-field control of nested-object patch semantics. See [validation.md § Validator modes](validation.md#validator-modes-at-a-glance) for the validator-side detail.

| Branch                                                 | Strategy | Validator behaviour                                     | Storage behaviour                                    |
| ------------------------------------------------------ | -------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Default (no annotation)                                | replace  | Strict — every required child must be present, else 400 | Optional children user omits → explicit `null`       |
| `@db.patch.strategy 'merge'` (one level)               | merge    | Partial — omitted siblings allowed                      | Omitted siblings preserved                           |
| Descendant of a merge branch (no annotation)           | replace  | Strict again — merge does NOT propagate                 | Same as default                                      |
| Merge branch inside a replace branch                   | merge    | Partial — but sent if required (the parent is strict)   | Omitted children kept; parent's own omitted → `null` |
| `@db.json` field                                       | replace  | Always strict — opaque blob, no partial decomposition   | Whole JSON value rewritten                           |
| `'merge'` object NOT reached by its own path (0.1.184) | inert    | Strict — a partial object is rejected, as on insert     | Written as part of the whole value                   |

```atscript
interface User {
    @meta.id
    id: number

    @db.patch.strategy 'merge'
    profile?: Profile     // sub-fields preserved on partial patch
    address: Address      // default replace — required required, optional nulled
}
```

Examples (PATCH semantics):

```ts
// Replace, full required shape — optional fields omitted are null-filled.
await users.updateOne({
  id: 1,
  address: { line1: "1 Pike Pl", city: "Seattle", state: "WA", zip: "98101" },
  // address.line2 (optional) omitted → stored as null
});

// Replace, missing a required child — REJECTED.
await users.updateOne({ id: 1, address: { city: "Seattle" } });
// ValidatorError: address.line1 is required, address.state is required, ...

// Merge — omitted siblings preserved.
await users.updateOne({ id: 1, profile: { bio: "..." } });

// Merge does NOT propagate. If profile.address has no merge annotation,
// it's still replace — partial input on it would be rejected unless every
// required child is supplied.

// Merge stays merge inside a replaced object (address is replace, address.geo merge):
await users.updateOne({ id: 1, address: { ...requiredAddress, geo: { lat: 1 } } });
// address's omitted optional children → null; geo.lng (omitted) KEPT.
// Leave geo out or send null → cleared; send {} → kept as stored.
```

A merge object stored as `null` / missing (any depth) becomes what the patch sends, on every adapter and write path (MongoDB `updateMany` threw before 0.1.183). Merge inside replace — same result on EVERY adapter, any depth, with array ops inside the merge object, through `updateOne` / `bulkUpdate` / `updateMany` / HTTP PATCH (0.1.183). ≤ 0.1.182: SQLite / PostgreSQL / MySQL nulled the merge object's omitted columns (a required child too); memory stored the parent as sent (children lost); MongoDB `updateOne` / `bulkUpdate` already kept them, its `updateMany` replaced the parent whole.

`@db.patch.strategy` is the only strategy annotation, MongoDB included — `@db.mongo.patch.strategy` no longer exists ([mongo-annotations.md](mongo-annotations.md#replaced--removed-use-the-generic-core-annotation-instead)).

## Where merge applies (0.1.184)

ONE rule, the same for validation (server + db-client preflight), field ops, array ops and every adapter: a merge strategy applies to an object only where a patch reaches that object by its OWN PATH — from the row's top through stored objects. An object `T | null` IS a `T`: merge on it (compiles since 0.1.184) or inside it merges on every adapter (`T[] | null` + merge = build error: array ops are refused there). Under an array / tuple element, a union member (`Prefs | string`, `A | B`), a `@db.json` or `@db.encrypted` field, and on such a field (or on a union field) itself, it has NO EFFECT on every adapter: the object is validated in full (partial → rejected like insert) and written as part of the whole value. `$inc`/`$dec`/`$mul` allowed only when every enclosing object is a merge object reached by path (else refused: a top-level `FIELD_OP_CONTEXT` entry under a tuple / array element; under a `T | null` or a union member the union's entry, whose `details` carry `FIELD_OP_CONTEXT`; via a relation the path starts with the relation field). A shared type keeps merging where reached by path. Merge on an array field = keyed `$update`/`$upsert` merge into the element, one level deep (a nested merge object in the item is replaced). `mergeStrategyPaths(type)` (`@atscript/db/validator`) = the set of dot-paths where it applies — form/patch builders send partial objects only there.

- ≤ 0.1.183: partial merge objects in those places passed validation and were stored without their omitted (even required) children; SQL merged a union-of-objects member; `@db.json` + merge on one field → SQLite `no such column`, memory + Mongo merged; `@db.encrypted` + merge → metadata build threw; a merge object inside a `T | null` lost omitted children on memory + Mongo; field ops inside a non-merge `T | null` / union member were APPLIED on SQL (now refused — breaking for SQL apps: add `'merge'` or send the computed value) and stored as `{ "$inc": 1 }` on memory + Mongo; in a tuple element they were stored as the value.
- Build errors (editor diagnostics), author feedback only: merge on a field with `@db.json` / `@db.encrypted`; merge WRITTEN inside an array element or a `@db.json` / `@db.encrypted` field. Not build errors (and no effect in those places): merge fields of referenced types, of objects written in type groups (`| null`, `&`, unions, tuples). An `annotate`-block merge on a top-level field is checked like one written there (0.1.194; was never a build error); on a nested entry it is not checked — see [annotations.md](annotations.md#annotate-blocks). No runtime error for any placement.
- Write shape of a `T | null` object WITHOUT a merge child: only Mongo `updateOne` / `bulkUpdate` changed — field by field like a plain replaced object (omitted optional → `null`, stored keys outside the type survive); Mongo `updateMany` and memory (unless the patch carries a merge object / array op inside) still set it whole (the updateOne/updateMany difference plain objects already have on Mongo). `/meta` keeps `db.encrypted` (0.1.184).

## `@db.json` columns

Fields tagged `@db.json` are serialized to a single JSON column (or native `JSONB`/`JSON` type per adapter). Patch handling:

- Written as ONE value on every adapter: a patch replaces the whole column (SQL `SET col = ?`; MongoDB `$set` of the literal object). Since 0.1.155 a MongoDB object value (`@db.json`, a union of objects; `T | null` — since 0.1.184 written field by field in `updateOne` / `bulkUpdate`, still whole in `updateMany`; renamed with `@db.column` too) REPLACES the stored object (plain nested objects keep their `@db.patch.strategy`) — before, the pipeline `$set` merged it in (a member switch kept the old member's keys).
- See the one rule in § Where merge applies above.

## `@db.depth.limit N` — security guard on nested writes

Controls whether writes (insert / replace / patch) may traverse `@db.rel.from` navigation relations to create/replace/patch related records. Purely a write-acceptance control; has no effect on `/meta` shape.

| Value        | Effect                                                                           |
| ------------ | -------------------------------------------------------------------------------- |
| absent / `0` | Server rejects any nested-write payload with HTTP 400.                           |
| `N ≥ 1`      | Accept nesting up to depth `N`. Payloads deeper than `N` rejected with HTTP 400. |

```atscript
@db.table 'authors'
@db.depth.limit 2
interface Author { ... }
```

## MongoDB `CollectionPatcher`

Converts patch payloads to `$set` aggregation stages using `$reduce`, `$filter`, `$map`, `$concatArrays`, `$in` (operator items always as `$literal`, 0.1.180). One update call = one round-trip regardless of array op count. Works within transactions (when the adapter is constructed with a `MongoClient`).

## SQL patch decomposition

`decomposePatch(data, metadata)` flattens nested objects into dot-paths, separates field ops, and emits:

- scalar `SET col = ?` assignments,
- `SET col = col + ?` / `- ?` / `* ?` for field ops,
- dot-path sets for merge-strategy nested objects (a `@db.json` column is always set whole).

Array ops against scalar arrays in SQL columns emit an in-application diff-and-replace, since SQL dialects don't have first-class array algebra portable across engines.

## Errors

- `ValidatorError` (from `@atscript/typescript`) — required field missing on replace, bad value shape.
- `DbError('FK_VIOLATION')` — FK existence check failed on write.
- `DbError('DEPTH_EXCEEDED')` (`DepthLimitExceededError`) — payload nests past `@db.depth.limit N`.
- `DbError('CONFLICT')` — unique-index violation; a nested relation write naming a row outside the record's relation (0.1.143) → [relations.md § Nested-write integrity](relations.md#nested-write-integrity-01143).
