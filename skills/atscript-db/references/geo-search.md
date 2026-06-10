# geo-search (db.geoPoint + @db.index.geo + geoSearch + $geoWithin)

"Find things near me": declare a `db.geoPoint` field, index it with `@db.index.geo`, query with distance-ranked `geoSearch()` or the `$geoWithin` radius predicate. Portable contract, **MongoDB-only implementation in v1** — SQL adapters skip the index (warning) and throw `GEO_NOT_SUPPORTED` on geo queries.

**TL;DR.** `geo: db.geoPoint` is a `[longitude, latitude]` tuple (GeoJSON order — **lng first**). `geoSearch(point, query)` returns rows distance-ascending, each with `$distance` (meters). `filter: { geo: { $geoWithin: { center, radius } } }` is the pure predicate. HTTP: `GET <base>/geo?$center=lng,lat`.

## Quick start

```atscript
@db.table 'listings'
export interface Listing {
    @meta.id
    id: number
    status: string
    @db.index.geo
    geo: db.geoPoint          // [lng, lat]
}
```

```ts
const listings = db.getTable(Listing);

// Distance-ranked (mirrors vectorSearch; MongoDB only in v1)
const near = await listings.geoSearch([-122.42, 37.77], {
  filter: { status: "ACTIVE" },
  controls: { $maxDistance: 50_000, $limit: 20 }, // meters
});
near[0].$distance; // meters, rows sorted ascending

// Paginated
const { data, count } = await listings.geoSearchWithCount([-122.42, 37.77], {
  filter: {},
  controls: { $limit: 10 },
});

// Boolean predicate — composes in any read path, no sort, no $distance
const within = await listings.findMany({
  filter: { status: "ACTIVE", geo: { $geoWithin: { center: [-122.42, 37.77], radius: 50_000 } } },
  controls: {},
});

// Multiple geo fields: name indexes, target one (same overloads as vectorSearch)
await rides.geoSearch("dropoff", [-122.42, 37.77]);
```

## Invariants

| #   | Rule                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Coordinates are `[lng, lat]`** (GeoJSON order, longitude first) — everywhere: field values, `geoSearch` point, `$geoWithin.center`, URL `$center`. The #1 geo bug.                                                                                                                     |
| 2   | Writes validate: length 2, finite, `lng ∈ [-180,180]`, `lat ∈ [-90,90]` → else validation error / HTTP 400.                                                                                                                                                                              |
| 3   | All distances are **meters**, spherical. `$maxDistance` / `$minDistance` ride in `controls` of `geoSearch`.                                                                                                                                                                              |
| 4   | `geoSearch` results are always distance-ascending; user `$sort` on this path → `INVALID_QUERY`. `$skip`/`$limit`/`$select`/`$with`/filter compose normally. `$distance` is attached to every row.                                                                                        |
| 5   | v1 capability: only `MongoAdapter.isGeoSearchable() === true`. SQL adapters: `geoSearch`/`$geoWithin` → `DbError("GEO_NOT_SUPPORTED")` (loud, never a silent scan); sync logs a warning and skips the index. Same `.as` model still syncs everywhere (test parity on `:memory:` SQLite). |
| 6   | `geoSearch` on a table with no `@db.index.geo` (or unknown index name) → `GEO_INDEX_MISSING`. `$geoWithin` on a non-geoPoint field → `FILTER_TYPE_MISMATCH`.                                                                                                                             |
| 7   | `$geoWithin` is circle-only (`{ center, radius }`, radius > 0 meters), works without an index (engine scans), composes under `$and`/`$or`/`$not`.                                                                                                                                        |
| 8   | Mongo storage is GeoJSON `Point` but the app NEVER sees it — tuples in, tuples out. Managed `2dsphere` index named `atscript__geo__<name>`, drift-corrected by `syncIndexes()`.                                                                                                          |
| 9   | `@db.index.geo` requires a top-level `db.geoPoint` (or plain `number[]`) field; cannot combine with `@meta.id`, `@db.index.unique`, `@db.rel.FK`, `@db.json`, `@db.encrypted`.                                                                                                           |
| 10  | `/meta`: geo-indexed fields report `geo: true` and `sortable: false`; top-level `geoSearchable` is true only when adapter supports geo AND a geo index exists; `crud.geo` lists the endpoint controls.                                                                                   |
| 11  | HTTP `GET <base>/geo?$center=lng,lat[&$maxDistance=m][&$minDistance=m][&$index=name]` + standard filter/`$select`/`$with`. With `$page`/`$size` → `/pages` envelope; else row array. Missing `$center` → 400. `$geoWithin` has no URL encoding (use `/geo`).                             |
| 12  | Toggling `@db.index.geo` / `db.geoPoint` changes the schema hash → sync runs; on SQL it's a warn-and-skip no-op so adapter switching doesn't thrash.                                                                                                                                     |

## Key imports

```ts
import { DbSpace, DbError } from "@atscript/db";
// table methods: table.geoSearch(), table.geoSearchWithCount(), table.isGeoSearchable()
// db-client: client.geoSearch(point, query?), client.geoPages(point, query?, page, size)
```

## References

| Domain           | File                                           | When                                               |
| ---------------- | ---------------------------------------------- | -------------------------------------------------- |
| Vector search    | [adapters-mongo.md](./adapters-mongo.md)       | The sibling search path geo mirrors; Atlas indexes |
| URL query syntax | [http-query-syntax.md](./http-query-syntax.md) | The standard controls `/geo` composes with         |
| Browser client   | [db-client.md](./db-client.md)                 | `client.geoSearch` / `geoPages` typing             |
| Encryption       | [encryption.md](./encryption.md)               | `@db.encrypted` (mutually exclusive)               |
| Schema sync      | [schema-sync.md](./schema-sync.md)             | Hash drift, managed-index lifecycle                |

## See also

- Docs: https://db.atscript.dev/search/geo-search
