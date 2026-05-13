# patch

Decompose patch payloads into: scalar sets, field ops (`$inc`/`$dec`/`$mul`), array ops, JSON-column merges. SQL adapters emit `UPDATE … SET col = ?`; MongoDB emits a `$set` aggregation pipeline via `CollectionPatcher`.

## Field ops

```ts
import { $inc, $dec, $mul } from "@atscript/db/ops";

await posts.updateOne({ id: 1, views: $inc() }); // +1 atomic
await products.updateOne({ id: 42, stock: $dec(5) });
await products.updateOne({ id: 42, price: $mul(1.1) });
await users.updateMany({ status: "active" }, { points: $inc(100) });
```

| Helper      | SQL                 | MongoDB          |
| ----------- | ------------------- | ---------------- |
| `$inc(n=1)` | `SET col = col + ?` | `$inc`           |
| `$dec(n=1)` | `SET col = col - ?` | `$inc` (negated) |
| `$mul(n)`   | `SET col = col * ?` | `$mul`           |

The `separateFieldOps()` helper strips these from the data payload before regular value handling. Mix with scalar assignments freely.

## Array ops

```ts
import { $replace, $insert, $upsert, $update, $remove } from "@atscript/db/ops";

await users.updateOne({
  id: 1,
  tags: $insert(["new"]), // append
  addresses: $upsert([{ id: "home", street: "..." }]), // key-match or append
  devices: $update([{ id: "phone", lastSeen: now }]), // key-match, update only
  permissions: $remove([{ role: "guest" }]), // key-match, remove
  preferences: $replace([{ theme: "dark" }]), // overwrite the whole array
});
```

Key-based ops (`$upsert`, `$update`, `$remove`) require `@expect.array.key` on the element's key field so the patcher knows what to match on.

## `@db.patch.strategy`

Per-field control of nested-object patch semantics. See [validation.md § Validator modes](validation.md#validator-modes-at-a-glance) for the validator-side detail.

| Branch                                       | Strategy | Validator behaviour                                     | Storage behaviour                              |
| -------------------------------------------- | -------- | ------------------------------------------------------- | ---------------------------------------------- |
| Default (no annotation)                      | replace  | Strict — every required child must be present, else 400 | Optional children user omits → explicit `null` |
| `@db.patch.strategy 'merge'` (one level)     | merge    | Partial — omitted siblings allowed                      | Omitted siblings preserved                     |
| Descendant of a merge branch (no annotation) | replace  | Strict again — merge does NOT propagate                 | Same as default                                |
| `@db.json` field                             | replace  | Always strict — opaque blob, no partial decomposition   | Whole JSON value rewritten                     |

```atscript
interface User {
    @meta.id id: number
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
```

MongoDB offers `@db.mongo.patch.strategy` for per-field override without changing the global shape.

## `@db.json` columns

Fields tagged `@db.json` are serialized to a single JSON column (or native `JSONB`/`JSON` type per adapter). Patch handling:

- SQL adapters: the column is read, merged in JS, and written back (one round-trip).
- MongoDB: stored verbatim in the document; patch goes through the usual pipeline.

Avoid `@db.json` on high-write fields — every partial update becomes a read-modify-write.

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

Converts patch payloads to `$set` aggregation stages using `$reduce`, `$filter`, `$map`, `$concatArrays`, `$setUnion`, `$setDifference`. One update call = one round-trip regardless of array op count. Works within transactions (when the adapter is constructed with a `MongoClient`).

## SQL patch decomposition

`decomposePatch(data, metadata)` flattens nested objects into dot-paths, separates field ops, and emits:

- scalar `SET col = ?` assignments,
- `SET col = col + ?` / `- ?` / `* ?` for field ops,
- JSON column merges for `@db.json` / nested objects (with `'merge'` strategy).

Array ops against scalar arrays in SQL columns emit an in-application diff-and-replace, since SQL dialects don't have first-class array algebra portable across engines.

## Errors

- `ValidatorError` (from `@atscript/typescript`) — required field missing on replace, bad value shape.
- `DbError('FK_VIOLATION')` — FK existence check failed on write.
- `DbError('DEPTH_EXCEEDED')` (`DepthLimitExceededError`) — payload nests past `@db.depth.limit N`.
- `DbError('CONFLICT')` — unique-index violation.
