import {
  GeoControlsDto,
  GetOneControlsDto,
  PagesControlsDto,
  QueryControlsDto,
} from "../dto/controls.dto.as";

/**
 * Static control whitelists per read op. Each list is the matching DTO's
 * `$`-properties (stripped) plus the URL-grammar extras (`filter`,
 * `insights`, `groupBy`) that bypass the DTO. The DTO is the single source of
 * truth — adding a `$control` there auto-extends the whitelist here.
 */

const dtoControls = (Dto: { type: { props: ReadonlyMap<string, unknown> } }): string[] =>
  [...Dto.type.props.keys()].map((k) => (k.startsWith("$") ? k.slice(1) : k));

export const QUERY_CONTROLS: readonly string[] = [
  "filter",
  "insights",
  ...dtoControls(QueryControlsDto),
  "groupBy",
  // `$rowOrder` — the row order `first()` / `last()` read (URL grammar, grouped queries; since 0.1.148)
  "rowOrder",
  // `$from` — the inner level of a two-level aggregate (since 0.1.168)
  "from",
];

/**
 * The `crud.query` controls only an aggregate `/query` takes — a value-help
 * endpoint drops them all; a db readable drops just `from` while two-level
 * aggregates are off. Internal: not exported from the package.
 */
export const AGGREGATE_ONLY_CONTROLS: ReadonlySet<string> = new Set([
  "groupBy",
  "rowOrder",
  "from",
]);

export const PAGES_CONTROLS: readonly string[] = ["filter", ...dtoControls(PagesControlsDto)];

export const ONE_CONTROLS: readonly string[] = dtoControls(GetOneControlsDto);

/**
 * Controls accepted by the `/geo` endpoint — `GeoControlsDto` (since 0.1.143;
 * `$center` / `$maxDistance` / `$minDistance` are parsed by the handler
 * before the DTO check) plus the URL-grammar `filter` / `insights`.
 */
export const GEO_CONTROLS: readonly string[] = [
  "filter",
  "insights",
  ...dtoControls(GeoControlsDto),
];
