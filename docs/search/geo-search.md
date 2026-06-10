---
outline: deep
---

# Geo Search

<!--@include: ../_experimental-warning.md-->

Geo search enables "find things near me" queries: declare a coordinate field with `db.geoPoint`, index it with `@db.index.geo`, then run distance-ranked searches with `geoSearch()` or radius predicates with the `$geoWithin` filter operator.

The contract is portable — the same `.as` model compiles, validates, and syncs on every adapter — but **the v1 implementation is MongoDB-only**. SQL adapters skip the index with a warning and reject geo queries loudly (never a silent table scan). This mirrors how `search()`/`vectorSearch()` work: adapters opt in via capability flags.

## Defining a Geo Field

```atscript
@db.table 'listings'
export interface Listing {
    @meta.id
    id: number

    title: string
    status: string

    @db.index.geo
    geo: db.geoPoint
}
```

- `db.geoPoint` is a `[longitude, latitude]` tuple — a semantic alias for `number[]` of length 2.
- `@db.index.geo` declares the geospatial index. An optional string argument names the index (defaults to the field name) — relevant only when a table has several geo fields.

::: warning Coordinate order is GeoJSON order: longitude first
`[lng, lat]`, not `[lat, lng]`. This is the single most common geo bug. San Francisco is `[-122.42, 37.77]`.
:::

Writes validate coordinates automatically: exactly two finite numbers, `lng ∈ [-180, 180]`, `lat ∈ [-90, 90]`. Out-of-range values are rejected with a validation error (HTTP 400 over REST).

### Constraints

`@db.index.geo` requires a `db.geoPoint` (or structurally identical `number[]`) field, must be **top-level** (not nested), and cannot combine with `@meta.id`, `@db.index.unique`, `@db.rel.FK`, `@db.json`, or [`@db.encrypted`](/api/encryption). Violations fail at compile/build time.

## Distance-Ranked Search: `geoSearch()`

Mirrors [`vectorSearch()`](/search/vector-search): results are sorted by distance ascending, and every row carries a computed `$distance` field (meters from the query point).

```typescript
const listings = db.getTable(Listing);

const near = await listings.geoSearch([-122.42, 37.77], {
  filter: { status: "ACTIVE" },
  controls: { $maxDistance: 50_000, $limit: 20 },
});

near[0].$distance; // meters from the query point
```

Controls (all distances in **meters**, spherical/great-circle):

| Control             | Description                                        |
| ------------------- | -------------------------------------------------- |
| `$maxDistance`      | Exclude rows farther than this                     |
| `$minDistance`      | Exclude rows closer than this (ring queries)       |
| `$skip` / `$limit`  | Pagination — compose normally                      |
| `$select` / `$with` | Projection and relation loading — compose normally |

`$sort` is **rejected** on this path — results are always distance-ordered (same posture as vector search being score-sorted).

For paginated results use `geoSearchWithCount()`:

```typescript
const { data, count } = await listings.geoSearchWithCount([-122.42, 37.77], {
  filter: { status: "ACTIVE" },
  controls: { $limit: 10 },
});
```

### Multiple Geo Fields

Name the indexes and target one by passing the index name first (same overload shape as `vectorSearch`):

```atscript
@db.index.geo 'pickup'
pickupPoint: db.geoPoint

@db.index.geo 'dropoff'
dropoffPoint: db.geoPoint
```

```typescript
await rides.geoSearch("dropoff", [-122.42, 37.77], { filter: {}, controls: {} });
```

### Capability Checks & Errors

```typescript
listings.isGeoSearchable(); // true on MongoDB, false elsewhere (v1)
```

| Error code             | When                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `GEO_NOT_SUPPORTED`    | `geoSearch()` or `$geoWithin` on an adapter without geo support          |
| `GEO_INDEX_MISSING`    | `geoSearch()` on a table with no `@db.index.geo` (or unknown index name) |
| `FILTER_TYPE_MISMATCH` | `$geoWithin` targeting a non-`geoPoint` field                            |
| `INVALID_QUERY`        | Bad query point / negative distances / `$sort` on the geo path           |

## Radius Predicate: `$geoWithin`

A boolean filter operator usable in **any** read path (`findMany`, `count`, `updateMany`/`deleteMany` filters). It does not sort and does not compute `$distance` — use `geoSearch()` for ranking:

```typescript
const within = await listings.findMany({
  filter: {
    status: "ACTIVE",
    geo: { $geoWithin: { center: [-122.42, 37.77], radius: 50_000 } },
  },
  controls: {},
});
```

- `center` is `[lng, lat]`, `radius` is meters, both required. Circles only in v1.
- Works without a geo index (the engine scans); `@db.index.geo` accelerates it.
- Composes under `$and` / `$or` / `$not` like any other operator.

## HTTP Access: `GET /geo`

The `moost-db` controller exposes a dedicated endpoint mirroring the search/vector read endpoints:

```
GET /listings/geo?$center=-122.42,37.77&$maxDistance=50000&status=ACTIVE
GET /listings/geo?$center=-122.42,37.77&$maxDistance=50000&$page=1&$size=20
```

| Parameter      | Description                                     |
| -------------- | ----------------------------------------------- |
| `$center`      | **Required.** `lng,lat` (GeoJSON order)         |
| `$maxDistance` | Meters — exclude rows farther than this         |
| `$minDistance` | Meters — exclude rows closer than this          |
| `$index`       | Geo index name (tables with several geo fields) |

Everything else is the standard [URL query syntax](/http/query-syntax) — filters, `$select`, `$with`, `$skip`/`$limit`. With `$page`/`$size` the response is the `/pages` envelope (`{ data, page, itemsPerPage, pages, count }`); otherwise a plain row array. Each row carries `$distance` (meters). Missing/malformed `$center` → 400; on a non-geo adapter the endpoint returns 400 with `GEO_NOT_SUPPORTED`.

`/meta` reports `geo: true` on geo-indexed fields (with `sortable: false` — distance ordering goes through `/geo`, not `$sort`) and a top-level `geoSearchable` flag.

From the browser client:

```typescript
const rows = await client.geoSearch([-122.42, 37.77], {
  filter: { status: "ACTIVE" },
  controls: { $maxDistance: 50_000 },
});
rows[0].$distance; // meters

const page = await client.geoPages([-122.42, 37.77], {}, 1, 20);
```

## Adapter Support

| Adapter        | v1 behavior                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MongoDB**    | ✅ Full support — stores GeoJSON `Point`, syncs a managed `2dsphere` index (`atscript__` prefix), `$geoNear`-backed `geoSearch`, `$centerSphere`-backed `$geoWithin` |
| **PostgreSQL** | Index skipped with a warning; `geoSearch`/`$geoWithin` → `GEO_NOT_SUPPORTED` (PostGIS planned)                                                                       |
| **MySQL**      | Index skipped with a warning; `geoSearch`/`$geoWithin` → `GEO_NOT_SUPPORTED` (`POINT SRID 4326` planned)                                                             |
| **SQLite**     | Index skipped with a warning; `geoSearch`/`$geoWithin` → `GEO_NOT_SUPPORTED` (haversine fallback planned)                                                            |

Models stay portable: an app whose test suite runs on `:memory:` SQLite can sync the same `.as` file everywhere — only geo _queries_ require MongoDB in v1. On MongoDB the application never sees GeoJSON wrappers: you write and read plain `[lng, lat]` tuples; the adapter converts at the storage boundary.

Schema sync notes: adding/removing `@db.index.geo` changes the schema hash and triggers a sync. On MongoDB the `2dsphere` index is created/dropped via the managed-index drift correction; on SQL adapters it contributes to the hash but syncs to a no-op + warning, so switching adapters doesn't thrash. See [What Gets Synced](/sync/what-gets-synced).

## Next Steps

- [Vector Search](./vector-search) — the sibling similarity-search path this API mirrors
- [Field Encryption](/api/encryption) — mutually exclusive with geo indexes
- [URL Query Syntax](/http/query-syntax) — the standard controls `/geo` composes with
