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
];

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
