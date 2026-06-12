---
outline: deep
---

# Geo Search

<!--@include: ../_experimental-warning.md-->

Geo search enables "find things near me" queries: declare a coordinate field with `db.geoPoint`, index it with `@db.index.geo`, then run distance-ranked searches with `geoSearch()` or radius predicates with the `$geoWithin` filter operator.

The contract is portable **and runs natively on every adapter**: MongoDB stores GeoJSON `Point` with a `2dsphere` index, PostgreSQL uses PostGIS `geography(Point,4326)` with a GiST index, MySQL uses `POINT SRID 4326`, and SQLite computes haversine distances over the JSON-stored tuple. Your application always reads and writes plain `[lng, lat]` tuples — each adapter converts at the storage boundary. Adapters report availability via capability flags (only PostgreSQL without the PostGIS extension degrades to a non-searchable JSONB fallback).

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
listings.isGeoSearchable(); // true everywhere except PostgreSQL without PostGIS
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

| Adapter        | Storage                                          | Index                                         | Distance engine                               |
| -------------- | ------------------------------------------------ | --------------------------------------------- | --------------------------------------------- |
| **MongoDB**    | GeoJSON `Point`                                  | Managed `2dsphere`                            | `$geoNear` / `$centerSphere` (sphere)         |
| **PostgreSQL** | PostGIS `geography(Point,4326)` (JSONB fallback) | Managed GiST                                  | `ST_Distance` / `ST_DWithin` (WGS84 spheroid) |
| **MySQL**      | `POINT SRID 4326`                                | Managed `SPATIAL` (requires a required field) | `ST_Distance_Sphere` (sphere)                 |
| **SQLite**     | JSON `[lng, lat]` text                           | None (scan-based)                             | Haversine in SQL (sphere, R = 6 371 km)       |

Adapter notes:

- **PostgreSQL** — the adapter runs `CREATE EXTENSION IF NOT EXISTS postgis` during sync. If the extension can't be enabled (no superuser, not installed), `db.geoPoint` columns fall back to JSONB, the index is skipped with a warning, and geo queries fail with `GEO_NOT_SUPPORTED` — never a silent scan. Distances use the WGS84 spheroid (PostGIS default), so they can differ from the spherical engines by up to ~0.5%.
- **MySQL** — `SPATIAL` indexes require `NOT NULL` columns. On an optional `geo?: db.geoPoint` field the index is skipped with a warning; `geoSearch`/`$geoWithin` still work (scan-based). Make the field required to get the index.
- **SQLite** — needs SQLite math functions (`SQLITE_ENABLE_MATH_FUNCTIONS`; on by default in `better-sqlite3` builds). Declared geo indexes have no physical artifact; every geo query computes haversine per row — perfect for tests and small datasets.
- **Distance values** — `$distance` and `$maxDistance`/`radius` are always meters, but each engine uses its own earth model (see table). Don't assert exact cross-adapter equality; allow ~0.5% tolerance.

### Migrating from v1 (JSON storage)

Tables created before native geo support stored `db.geoPoint` as JSON. Schema sync detects the type drift and migrates the column **in place, preserving data**:

- **PostgreSQL** — `ALTER COLUMN ... TYPE geography(Point,4326) USING ST_SetSRID(ST_MakePoint(...), 4326)` built from the JSONB tuple (NULLs preserved).
- **MySQL** — a temp `POINT SRID 4326` column is added, populated from the JSON tuple, then swapped in for the original column.
- **SQLite** — no change; storage was already the final form.

Schema sync notes: adding/removing `@db.index.geo` changes the schema hash and triggers a sync; the managed index (`atscript__geo__*`) is created/dropped via drift correction on every adapter that materializes one. See [What Gets Synced](/sync/what-gets-synced).

## Next Steps

- [Vector Search](./vector-search) — the sibling similarity-search path this API mirrors
- [Field Encryption](/api/encryption) — mutually exclusive with geo indexes
- [URL Query Syntax](/http/query-syntax) — the standard controls `/geo` composes with
