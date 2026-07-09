import { describe, it, expect } from "vite-plus/test";

import { DbError } from "@atscript/db";
import type { FilterExpr } from "@atscript/db";

import { buildMemoryPredicate, getPath, hasPath } from "../memory-filter";

/** Build the predicate and immediately apply it to `row`. */
function match(filter: FilterExpr, row: Record<string, unknown>): boolean {
  return buildMemoryPredicate(filter)(row);
}

describe("getPath / hasPath", () => {
  it("getPath reads nested plain-object values and returns undefined for gaps (why: dot-path traversal)", () => {
    const row = { profile: { age: 30, city: "NYC" } };
    expect(getPath(row, "profile.age")).toBe(30);
    expect(getPath(row, "profile.city")).toBe("NYC");
    expect(getPath(row, "profile.missing")).toBeUndefined();
    expect(getPath(row, "missing.age")).toBeUndefined();
  });

  it("getPath does not descend into arrays (why: documented v1 limitation)", () => {
    const row = { tags: [{ name: "a" }] };
    expect(getPath(row, "tags.name")).toBeUndefined();
  });

  it("hasPath distinguishes present-null from absent (why: needed by $exists)", () => {
    const row = { a: null, b: { c: null } };
    expect(hasPath(row, "a")).toBe(true); // present, value null
    expect(hasPath(row, "b.c")).toBe(true); // nested present-null
    expect(hasPath(row, "missing")).toBe(false);
    expect(hasPath(row, "b.missing")).toBe(false);
  });
});

describe("empty / degenerate filters", () => {
  it("empty filter {} matches everything (why: absent expr → match-all)", () => {
    const p = buildMemoryPredicate({});
    expect(p({})).toBe(true);
    expect(p({ anything: 1 })).toBe(true);
  });

  it("{ $or: [] } matches nothing (why: empty disjunction is impossible, mirrors mongo _impossible)", () => {
    const p = buildMemoryPredicate({ $or: [] });
    expect(p({})).toBe(false);
    expect(p({ x: 1 })).toBe(false);
  });

  it("{ $and: [] } matches everything (why: empty conjunction is vacuously true)", () => {
    const p = buildMemoryPredicate({ $and: [] });
    expect(p({})).toBe(true);
  });
});

describe("$eq / $ne", () => {
  it("$eq matches equal scalars and rejects different/missing (why: strict value equality)", () => {
    expect(match({ name: "bob" }, { name: "bob" })).toBe(true);
    expect(match({ name: "bob" }, { name: "alice" })).toBe(false);
    expect(match({ name: "bob" }, {})).toBe(false);
  });

  it("$eq compares Dates by instant not identity (why: Date getTime() equality)", () => {
    const filter = { at: { $eq: new Date("2020-01-01T00:00:00Z") } } as FilterExpr;
    expect(match(filter, { at: new Date("2020-01-01T00:00:00Z") })).toBe(true);
    expect(match(filter, { at: new Date("2021-01-01T00:00:00Z") })).toBe(false);
  });

  it("$eq with a null value matches present-null AND a missing field (why: Mongo-like null model — null OR absent)", () => {
    // Bare `{ field: null }` shorthand.
    expect(match({ deleted: null }, { deleted: null })).toBe(true);
    expect(match({ deleted: null }, {})).toBe(true); // MISSING matches null
    expect(match({ deleted: null }, { deleted: 5 })).toBe(false);
    // Explicit `{ $eq: null }` operator form behaves identically.
    expect(match({ deleted: { $eq: null } } as FilterExpr, { deleted: null })).toBe(true);
    expect(match({ deleted: { $eq: null } } as FilterExpr, {})).toBe(true);
    expect(match({ deleted: { $eq: null } } as FilterExpr, { deleted: 5 })).toBe(false);
  });

  it("$eq null matches an absent NESTED path too (why: getPath → undefined == null)", () => {
    expect(match({ "profile.city": null }, { profile: {} })).toBe(true); // present-obj, absent key
    expect(match({ "profile.city": null }, {})).toBe(true); // whole path absent
    expect(match({ "profile.city": null }, { profile: { city: null } })).toBe(true);
    expect(match({ "profile.city": null }, { profile: { city: "NYC" } })).toBe(false);
  });

  it("$ne null matches ONLY a concrete present value, not null or missing (why: negation of the null model)", () => {
    expect(match({ deleted: { $ne: null } } as FilterExpr, { deleted: 5 })).toBe(true);
    expect(match({ deleted: { $ne: null } } as FilterExpr, { deleted: null })).toBe(false);
    expect(match({ deleted: { $ne: null } } as FilterExpr, {})).toBe(false); // missing → not matched
  });

  it("$eq with a bare RegExp value behaves as a regex match (why: Mongo bare-RegExp shorthand)", () => {
    expect(match({ name: /^bo/ }, { name: "bob" })).toBe(true);
    expect(match({ name: /^bo/ }, { name: "alice" })).toBe(false);
  });

  it("$eq with a bare RegExp does not match a missing/null field (why: null-guard, parity with $regex)", () => {
    expect(match({ name: /^bo/ }, {})).toBe(false);
    expect(match({ name: /^bo/ }, { name: null })).toBe(false);
  });

  it("$ne with a bare RegExp matches a missing/null field (why: strict negation of null-guarded $eq)", () => {
    expect(match({ name: { $ne: /^bo/ } } as FilterExpr, {})).toBe(true);
    expect(match({ name: { $ne: /^bo/ } } as FilterExpr, { name: null })).toBe(true);
  });

  it("$ne is the strict negation of $eq (why: complementary semantics)", () => {
    expect(match({ name: { $ne: "bob" } }, { name: "alice" })).toBe(true);
    expect(match({ name: { $ne: "bob" } }, { name: "bob" })).toBe(false);
  });

  it("$ne treats a missing field as not-equal → match (why: Mongo-like null/absence behavior)", () => {
    expect(match({ name: { $ne: "bob" } }, {})).toBe(true);
  });
});

describe("$gt / $gte / $lt / $lte", () => {
  it("orders numbers with JS semantics (why: plain numeric ordering)", () => {
    expect(match({ age: { $gt: 18 } }, { age: 21 })).toBe(true);
    expect(match({ age: { $gt: 18 } }, { age: 18 })).toBe(false);
    expect(match({ age: { $gte: 18 } }, { age: 18 })).toBe(true);
    expect(match({ age: { $lt: 18 } }, { age: 17 })).toBe(true);
    expect(match({ age: { $lte: 18 } }, { age: 18 })).toBe(true);
  });

  it("orders strings lexicographically (why: JS string ordering, no collation)", () => {
    expect(match({ name: { $gt: "b" } }, { name: "c" })).toBe(true);
    expect(match({ name: { $gt: "b" } }, { name: "a" })).toBe(false);
    expect(match({ name: { $lte: "m" } }, { name: "m" })).toBe(true);
  });

  it("orders Dates by instant (why: Date operands normalized via getTime())", () => {
    const filter = { at: { $gt: new Date("2020-01-01T00:00:00Z") } } as FilterExpr;
    expect(match(filter, { at: new Date("2021-01-01T00:00:00Z") })).toBe(true);
    expect(match(filter, { at: new Date("2019-01-01T00:00:00Z") })).toBe(false);
  });

  it("never matches a missing or null field (why: ordering against nullish is undefined → false)", () => {
    expect(match({ age: { $gt: 18 } }, {})).toBe(false);
    expect(match({ age: { $gt: 18 } }, { age: null })).toBe(false);
    expect(match({ age: { $lt: 18 } }, { age: null })).toBe(false);
  });
});

describe("$in / $nin", () => {
  it("$in is true iff the field equals a member (why: membership over the array)", () => {
    expect(match({ role: { $in: ["admin", "user"] } }, { role: "user" })).toBe(true);
    expect(match({ role: { $in: ["admin", "user"] } }, { role: "guest" })).toBe(false);
  });

  it("$in matches Date and null members by value (why: reuses valuesEqual)", () => {
    const d = new Date("2020-01-01T00:00:00Z");
    expect(
      match({ at: { $in: [new Date("2020-01-01T00:00:00Z")] } } as FilterExpr, { at: d }),
    ).toBe(true);
    expect(match({ flag: { $in: [null] } }, { flag: null })).toBe(true);
  });

  it("$nin negates membership and is true for a missing field (why: absent field is 'not in')", () => {
    expect(match({ role: { $nin: ["admin"] } }, { role: "user" })).toBe(true);
    expect(match({ role: { $nin: ["admin"] } }, { role: "admin" })).toBe(false);
    expect(match({ role: { $nin: ["admin"] } }, {})).toBe(true);
  });
});

describe("$regex", () => {
  it("honors flags — /foo/i matches FOO case-insensitively (why: flags parsed from RegExp)", () => {
    expect(match({ name: { $regex: /foo/i } }, { name: "FOO" })).toBe(true);
    expect(match({ name: { $regex: /foo/ } }, { name: "FOO" })).toBe(false);
  });

  it("honors anchoring — /^a/ matches only a prefix (why: pattern is a real RegExp)", () => {
    expect(match({ name: { $regex: /^a/ } }, { name: "apple" })).toBe(true);
    expect(match({ name: { $regex: /^a/ } }, { name: "banana" })).toBe(false);
  });

  it("accepts a /pattern/flags string form (why: parseRegexString string parsing)", () => {
    expect(match({ name: { $regex: "/foo/i" } } as FilterExpr, { name: "FOObar" })).toBe(true);
  });

  it("does not match a non-string or absent field (why: null-guard + stringify)", () => {
    expect(match({ name: { $regex: /foo/ } }, {})).toBe(false);
    expect(match({ name: { $regex: /foo/ } }, { name: null })).toBe(false);
  });
});

describe("$exists", () => {
  it("$exists:true requires the key to be present, incl. present-null (why: keyed off existence)", () => {
    expect(match({ mid: { $exists: true } }, { mid: "x" })).toBe(true);
    expect(match({ mid: { $exists: true } }, { mid: null })).toBe(true);
    expect(match({ mid: { $exists: true } }, {})).toBe(false);
  });

  it("$exists:false requires the key to be absent (why: distinguishes null from missing)", () => {
    expect(match({ mid: { $exists: false } }, {})).toBe(true);
    expect(match({ mid: { $exists: false } }, { mid: null })).toBe(false);
    expect(match({ mid: { $exists: false } }, { mid: "x" })).toBe(false);
  });
});

describe("nested dot-path fields", () => {
  it("filters on nested numeric/string fields (why: dot paths traverse nested objects)", () => {
    const row = { profile: { age: 30, city: "NYC" } };
    expect(match({ "profile.age": { $gt: 18 } }, row)).toBe(true);
    expect(match({ "profile.city": "NYC" }, row)).toBe(true);
    expect(match({ "profile.city": "LA" }, row)).toBe(false);
  });

  it("does not match when an intermediate object is missing (why: getPath returns undefined)", () => {
    expect(match({ "profile.age": { $gt: 18 } }, {})).toBe(false);
    expect(match({ "profile.city": "NYC" }, { profile: 5 })).toBe(false);
  });
});

describe("$and / $or / $not composition", () => {
  it("$and requires all children (why: conjunction)", () => {
    const filter: FilterExpr = { $and: [{ age: { $gte: 18 } }, { role: "user" }] };
    expect(match(filter, { age: 20, role: "user" })).toBe(true);
    expect(match(filter, { age: 20, role: "admin" })).toBe(false);
    expect(match(filter, { age: 10, role: "user" })).toBe(false);
  });

  it("$or requires some child (why: disjunction)", () => {
    const filter: FilterExpr = { $or: [{ role: "admin" }, { age: { $gte: 65 } }] };
    expect(match(filter, { role: "admin", age: 30 })).toBe(true);
    expect(match(filter, { role: "user", age: 70 })).toBe(true);
    expect(match(filter, { role: "user", age: 30 })).toBe(false);
  });

  it("$not negates its child (why: logical negation)", () => {
    const filter: FilterExpr = { $not: { role: "admin" } };
    expect(match(filter, { role: "user" })).toBe(true);
    expect(match(filter, { role: "admin" })).toBe(false);
  });

  it("composes nested logical nodes (why: structural recursion via walkFilter)", () => {
    const filter: FilterExpr = {
      $and: [{ active: true }, { $or: [{ role: "admin" }, { $not: { banned: true } }] }],
    };
    expect(match(filter, { active: true, role: "admin", banned: true })).toBe(true);
    expect(match(filter, { active: true, role: "user", banned: false })).toBe(true);
    expect(match(filter, { active: true, role: "user", banned: true })).toBe(false);
    expect(match(filter, { active: false, role: "admin", banned: false })).toBe(false);
  });

  it("a multi-field comparison node is an implicit $and (why: walkFilter combines fields with and())", () => {
    const filter: FilterExpr = { role: "user", age: { $gte: 18 } };
    expect(match(filter, { role: "user", age: 20 })).toBe(true);
    expect(match(filter, { role: "user", age: 10 })).toBe(false);
  });
});

describe("unsupported operator", () => {
  it("throws DbError INVALID_QUERY for an unknown operator (why: cannot scan e.g. $geoWithin)", () => {
    const filter = {
      location: { $geoWithin: { center: [0, 0], radius: 1 } },
    } as unknown as FilterExpr;
    expect(() => buildMemoryPredicate(filter)).toThrow(DbError);
    try {
      buildMemoryPredicate(filter);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DbError);
      expect((err as DbError).code).toBe("INVALID_QUERY");
      expect((err as DbError).errors[0]?.path).toBe("location");
    }
  });
});
