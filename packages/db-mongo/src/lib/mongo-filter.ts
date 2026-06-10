import type { FilterExpr, FilterVisitor } from "@atscript/db";
import { walkFilter } from "@atscript/db";
import type { Document, Filter } from "mongodb";

const EMPTY: Filter<any> = {};

function parseRegexString(value: unknown): { pattern: string; flags: string } {
  if (value instanceof RegExp) {
    return { pattern: value.source, flags: value.flags };
  }
  const str = String(value);
  const match = str.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    return { pattern: match[1]!, flags: match[2]! };
  }
  return { pattern: str, flags: "" };
}

/**
 * Earth radius in meters used by MongoDB's `$centerSphere` radians conversion
 * (Mongo documents dividing by 6378.1 km).
 */
const EARTH_RADIUS_M = 6_378_100;

const mongoVisitor: FilterVisitor<Filter<any>> = {
  comparison(field: string, op: string, value: unknown): Filter<any> {
    if (op === "$eq") {
      return { [field]: value };
    }
    if (op === "$regex") {
      const { pattern, flags } = parseRegexString(value);
      return flags
        ? { [field]: { $regex: pattern, $options: flags } }
        : { [field]: { $regex: pattern } };
    }
    if (op === "$geoWithin") {
      // Circle predicate (core-validated shape: { center: [lng, lat], radius: meters }).
      // $centerSphere takes radians — meters / earth radius. Works without an index.
      const { center, radius } = value as { center: [number, number]; radius: number };
      return { [field]: { $geoWithin: { $centerSphere: [center, radius / EARTH_RADIUS_M] } } };
    }
    return { [field]: { [op]: value } };
  },
  and(children: Array<Filter<any>>): Filter<any> {
    if (children.length === 0) {
      return EMPTY;
    }
    if (children.length === 1) {
      return children[0];
    }
    return { $and: children };
  },
  or(children: Array<Filter<any>>): Filter<any> {
    if (children.length === 0) {
      return { _impossible: true };
    }
    if (children.length === 1) {
      return children[0];
    }
    return { $or: children };
  },
  not(child: Filter<any>): Document {
    return { $nor: [child] };
  },
};

/**
 * Translates a generic {@link FilterExpr} into a MongoDB-compatible
 * {@link Filter} document.
 *
 * MongoDB's query language is nearly identical to the `FilterExpr` structure,
 * so this is largely a structural pass-through via the `walkFilter` visitor.
 */
export function buildMongoFilter(filter: FilterExpr): Filter<any> {
  if (!filter || Object.keys(filter).length === 0) {
    return EMPTY;
  }
  return walkFilter(filter, mongoVisitor) ?? EMPTY;
}
