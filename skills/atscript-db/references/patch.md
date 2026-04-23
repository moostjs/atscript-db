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

Controls how nested objects merge:

- `'replace'` (default): the entire nested object is overwritten.
- `'merge'`: supplied sub-fields deep-merge into existing values.

```atscript
interface User {
    @meta.id id: number
    @db.patch.strategy 'merge'
    profile?: Profile
}
```

MongoDB offers `@db.mongo.patch.strategy` for per-field override without changing the global shape.

## `@db.json` columns

Fields tagged `@db.json` are serialized to a single JSON column (or native `JSONB`/`JSON` type per adapter). Patch handling:

- SQL adapters: the column is read, merged in JS, and written back (one round-trip).
- MongoDB: stored verbatim in the document; patch goes through the usual pipeline.

Avoid `@db.json` on high-write fields — every partial update becomes a read-modify-write.

## `@db.deep.insert N` — depth gate

Controls whether writes can traverse navigation relations (`@db.rel.from`, `@db.rel.via`) to create/replace/patch related records.

| Value        | Effect                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| absent / `0` | Server rejects any nested-write payload with HTTP 400. `/meta` returns shallow FK refs (`{ id, metadata }`).                          |
| `N ≥ 1`      | Accept nesting up to depth `N`. `/meta` returns `refDepth: N + 0.5` (client knows exactly how deep targets are expanded on the wire). |

```atscript
@db.table 'authors'
@db.deep.insert 2
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
- `DbError('DEPTH_EXCEEDED')` (`DeepInsertDepthExceededError`) — payload nests past `@db.deep.insert N`.
- `DbError('CONFLICT')` — unique-index violation.
