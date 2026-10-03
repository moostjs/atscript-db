import { randomBytes } from "node:crypto";

import { DbError, DbSpace, ResolvedRelationFilter } from "@atscript/db";
import { BSONRegExp } from "mongodb";
import { beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { buildMongoFilter, buildMongoQuery, mongoFilterStages } from "../mongo-filter";
import { prepareFixtures } from "./test-utils";

// Relational predicates ($some / $none) rendered as aggregation stages, since
// 0.1.147: pipeline shapes (no server) and where each read path puts them.

const adapter = {} as never;
const table = (name: string) => ({ table: name, name, adapter });

/** `ticket` of an issue: rf_issues.ticket_ref → rf_tickets.key */
function toTicket(filter: Record<string, unknown> = {}) {
  return new ResolvedRelationFilter({
    kind: "to",
    nav: "ticket",
    source: table("rf_issues"),
    target: table("rf_tickets"),
    pairs: [{ source: "ticket_ref", target: "key" }],
    filter,
  });
}

/** `labels` of a ticket, through rf_ticket_labels. */
function viaLabels(filter: Record<string, unknown> = {}, junctionFilter?: Record<string, unknown>) {
  return new ResolvedRelationFilter({
    kind: "via",
    nav: "labels",
    source: table("rf_tickets"),
    target: table("rf_labels"),
    pairs: [],
    junction: {
      ...table("rf_ticket_labels"),
      toSource: [{ junction: "ticketKey", source: "key" }],
      toTarget: [{ junction: "labelId", target: "id" }],
      ...(junctionFilter ? { filter: junctionFilter } : {}),
    },
    filter,
  });
}

/** The correlation stages: a bare (index-friendly) `$expr` `$eq`, then the query-level NULL guard. */
const guardedJoin = (prefix: string, inner: string) => [
  { $match: { $expr: { $eq: [`$${inner}`, `$$${prefix}k0`] } } },
  { $match: { [inner]: { $ne: null } } },
];
const TMP = "__atscript_rf_";
const exists = [{ $limit: 1 }, { $project: { _id: 1 } }];

describe("buildMongoQuery", () => {
  it("to: a guarded correlated $lookup, $some / $none read its array", () => {
    const some = buildMongoQuery({ ticket: { $some: toTicket({ status: "open" }) } } as never);
    expect(some).toEqual({
      pre: undefined,
      lookups: [
        {
          $lookup: {
            from: "rf_tickets",
            let: { rf0k0: { $ifNull: ["$ticket_ref", null] } },
            pipeline: [...guardedJoin("rf0", "key"), { $match: { status: "open" } }, ...exists],
            as: `${TMP}0`,
          },
        },
      ],
      match: { [`${TMP}0`]: { $ne: [] } },
      temp: [`${TMP}0`],
    });
    const none = buildMongoQuery({ ticket: { $none: toTicket() } } as never);
    expect(none.match).toEqual({ [`${TMP}0`]: { $size: 0 } });
    // `{}` operand: correlation only
    expect(none.lookups[0].$lookup.pipeline).toEqual([...guardedJoin("rf0", "key"), ...exists]);
  });

  it("composite keys: an $and of bare equalities, then one NULL guard per part", () => {
    const node = new ResolvedRelationFilter({
      kind: "to",
      nav: "board",
      source: table("rf_cards"),
      target: table("rf_boards"),
      pairs: [
        { source: "boardOrg", target: "org" },
        { source: "boardCode", target: "code" },
      ],
      filter: {},
    });
    const { lookups } = buildMongoQuery({ board: { $some: node } } as never);
    expect(lookups[0].$lookup.let).toEqual({
      rf0k0: { $ifNull: ["$boardOrg", null] },
      rf0k1: { $ifNull: ["$boardCode", null] },
    });
    expect(lookups[0].$lookup.pipeline.slice(0, 2)).toEqual([
      {
        $match: { $expr: { $and: [{ $eq: ["$org", "$$rf0k0"] }, { $eq: ["$code", "$$rf0k1"] }] } },
      },
      { $match: { org: { $ne: null }, code: { $ne: null } } },
    ]);
  });

  it("splits predicate-free top-level conjuncts into a pre-match", () => {
    const plan = buildMongoQuery({
      title: "x",
      $and: [{ id: { $gt: 1 } }, { ticket: { $some: toTicket() } }],
      $or: [{ id: 4 }, { ticket: { $none: toTicket() } }],
    } as never);
    expect(plan.pre).toEqual({ $and: [{ title: "x" }, { id: { $gt: 1 } }] });
    expect(plan.match).toEqual({
      $and: [{ [`${TMP}0`]: { $ne: [] } }, { $or: [{ id: 4 }, { [`${TMP}1`]: { $size: 0 } }] }],
    });
    expect(plan.temp).toEqual([`${TMP}0`, `${TMP}1`]);
  });

  it("$not around a predicate", () => {
    const plan = buildMongoQuery({ $not: { ticket: { $some: toTicket() } } } as never);
    expect(plan.match).toEqual({ $nor: [{ [`${TMP}0`]: { $ne: [] } }] });
  });

  it("nested predicates recurse into the sub-pipeline (pre-match, lookup, match)", () => {
    const team = new ResolvedRelationFilter({
      kind: "to",
      nav: "team",
      source: table("rf_tickets"),
      target: table("rf_teams"),
      pairs: [{ source: "team_ref", target: "id" }],
      filter: { name: "Core" },
    });
    const plan = buildMongoQuery({
      ticket: { $some: toTicket({ status: "open", team: { $some: team } }) },
    } as never);
    expect(plan.lookups[0].$lookup.pipeline).toEqual([
      ...guardedJoin("rf0", "key"),
      { $match: { status: "open" } },
      {
        $lookup: {
          from: "rf_teams",
          let: { rf1k0: { $ifNull: ["$team_ref", null] } },
          pipeline: [...guardedJoin("rf1", "id"), { $match: { name: "Core" } }, ...exists],
          as: `${TMP}1`,
        },
      },
      { $match: { [`${TMP}1`]: { $ne: [] } } },
      ...exists,
    ]);
    // Only the outer temp field is dropped — inner documents are projected to `_id`.
    expect(plan.temp).toEqual([`${TMP}0`]);
  });

  it("via: junction lookup (junction filter) wrapping the target lookup", () => {
    const plan = buildMongoQuery({
      labels: { $some: viaLabels({ label_name: "bug" }, { pinned: true }) },
    } as never);
    expect(plan.lookups).toEqual([
      {
        $lookup: {
          from: "rf_ticket_labels",
          let: { rf0k0: { $ifNull: ["$key", null] } },
          pipeline: [
            ...guardedJoin("rf0", "ticketKey"),
            { $match: { pinned: true } },
            {
              $lookup: {
                from: "rf_labels",
                let: { rf1k0: { $ifNull: ["$labelId", null] } },
                pipeline: [
                  ...guardedJoin("rf1", "id"),
                  { $match: { label_name: "bug" } },
                  ...exists,
                ],
                as: `${TMP}1`,
              },
            },
            { $match: { [`${TMP}1`]: { $ne: [] } } },
            ...exists,
          ],
          as: `${TMP}0`,
        },
      },
    ]);
  });

  it("mongoFilterStages: predicate-free → the plain $match; else pre → lookups → match → $unset", () => {
    expect(mongoFilterStages({ a: 1 })).toEqual([{ $match: { a: 1 } }]);
    expect(mongoFilterStages(undefined)).toEqual([{ $match: {} }]);
    const stages = mongoFilterStages({ a: 1, ticket: { $some: toTicket() } } as never);
    expect(stages.map((s) => Object.keys(s)[0])).toEqual(["$match", "$lookup", "$match", "$unset"]);
    expect(stages[0]).toEqual({ $match: { a: 1 } });
    expect(stages[3]).toEqual({ $unset: [`${TMP}0`] });
  });

  it("temporary fields use a reserved prefix, never a plausible field name", () => {
    const plan = buildMongoQuery({ __rf0: 1, ticket: { $some: toTicket() } } as never);
    expect(plan.pre).toEqual({ __rf0: 1 });
    expect(plan.temp).toEqual(["__atscript_rf_0"]);
  });

  it("a via operand without a junction, or a to/from one without pairs, is rejected (never an always-true join)", () => {
    const noJunction = new ResolvedRelationFilter({
      kind: "via",
      nav: "labels",
      source: table("rf_tickets"),
      target: table("rf_labels"),
      pairs: [{ source: "key", target: "id" }],
      filter: {},
    });
    const noPairs = new ResolvedRelationFilter({
      kind: "from",
      nav: "issues",
      source: table("rf_tickets"),
      target: table("rf_issues"),
      pairs: [],
      filter: {},
    });
    for (const node of [noJunction, noPairs]) {
      let error: unknown;
      try {
        buildMongoQuery({ [node.nav]: { $some: node } } as never);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe("REL_FILTER_NOT_SUPPORTED");
      expect((error as DbError).errors[0]!.path).toBe(node.nav);
    }
    const emptyJunction = viaLabels();
    (emptyJunction.junction as { toTarget: unknown[] }).toTarget = [];
    expect(() => buildMongoQuery({ labels: { $some: emptyJunction } } as never)).toThrow(
      /no junction correlation/,
    );
  });

  it("buildMongoFilter fails loud on a predicate (missed call site)", () => {
    let error: unknown;
    try {
      buildMongoFilter({ ticket: { $some: toTicket() } } as never);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("REL_FILTER_NOT_SUPPORTED");
    expect((error as DbError).errors[0]!.path).toBe("ticket");
  });

  it("an unresolved operand is rejected", () => {
    expect(() => buildMongoQuery({ ticket: { $some: { status: "open" } } } as never)).toThrow(
      /not resolved/,
    );
  });
});

const ci = (pattern: string) => new BSONRegExp(pattern, "i");
/** A related table's adapter with per-field collations. */
const collating = (fields: Record<string, "nocase" | "unicode" | "binary">) =>
  ({ fieldCollation: (field: string) => fields[field] }) as never;

describe("per-field collation in predicate pipelines", () => {
  const nocaseSource = {
    collation: (field: string) => (field === "nick" ? "nocase" : undefined),
  } as const;

  it("source 'nocase' fields: $eq / $ne / $in / $nin → anchored, escaped case-insensitive regexes", () => {
    const plan = buildMongoQuery(
      {
        nick: "A.b$",
        $or: [{ nick: { $ne: "x" } }, { nick: { $in: ["y", null, 5] } }, { nick: { $nin: ["z"] } }],
        role: "Admin",
        ticket: { $some: toTicket() },
      } as never,
      nocaseSource,
    );
    expect(plan.pre).toEqual({
      $and: [
        { nick: ci("^A\\.b\\$\\z") },
        {
          $or: [
            { nick: { $not: ci("^x\\z") } },
            { nick: { $in: [ci("^y\\z"), null, 5] } },
            { nick: { $nin: [ci("^z\\z")] } },
          ],
        },
        { role: "Admin" },
      ],
    });
  });

  it("$regex / $exists / non-string values on a 'nocase' field render as usual", () => {
    const plan = buildMongoQuery(
      {
        $and: [{ nick: { $regex: "^a" } }, { nick: { $exists: true } }, { nick: { $gt: 5 } }],
        ticket: { $some: toTicket() },
      } as never,
      nocaseSource,
    );
    expect(plan.pre).toEqual({
      $and: [{ nick: { $regex: "^a" } }, { nick: { $ne: null } }, { nick: { $gt: 5 } }],
    });
  });

  it("operands use the RELATED table's collation; join keys stay bare equalities", () => {
    const node = new ResolvedRelationFilter({
      kind: "to",
      nav: "team",
      source: table("c_members"),
      target: {
        table: "c_teams",
        name: "c_teams",
        adapter: collating({ name: "nocase", id: "nocase" }),
      },
      pairs: [{ source: "teamId", target: "id" }],
      filter: { name: "CORE", role: "ADMIN" },
    });
    const plan = buildMongoQuery({ team: { $some: node } } as never);
    expect(plan.lookups[0].$lookup.pipeline).toEqual([
      ...guardedJoin("rf0", "id"),
      { $match: { $and: [{ name: ci("^CORE\\z") }, { role: "ADMIN" }] } },
      ...exists,
    ]);
    // The source's collation does not reach the operand.
    const viaSource = buildMongoQuery(
      { team: { $some: toTicket({ nick: "X" }) } } as never,
      nocaseSource,
    );
    expect(viaSource.lookups[0].$lookup.pipeline[2]).toEqual({ $match: { nick: "X" } });
  });

  it("the junction part of @db.rel.filter uses the junction's collation", () => {
    const node = viaLabels({ label_name: "Bug" }, { kind: "Pin" });
    (node.junction as { adapter: unknown }).adapter = collating({ kind: "nocase" });
    const [lookup] = buildMongoQuery({ labels: { $some: node } } as never).lookups;
    expect(lookup.$lookup.pipeline[2]).toEqual({ $match: { kind: ci("^Pin\\z") } });
    expect(lookup.$lookup.pipeline[3].$lookup.pipeline[2]).toEqual({
      $match: { label_name: "Bug" },
    });
  });

  it("string ranges on 'nocase' and string comparisons on 'unicode' fields are rejected", () => {
    const reject = (filter: Record<string, unknown>, collation: "nocase" | "unicode") => {
      let error: unknown;
      try {
        buildMongoQuery({ ...filter, ticket: { $some: toTicket() } } as never, {
          collation: (field) => (field === "nick" ? collation : undefined),
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe("REL_FILTER_NOT_SUPPORTED");
      expect((error as DbError).errors[0]!.path).toBe("nick");
    };
    reject({ nick: { $gt: "a" } }, "nocase");
    reject({ nick: { $lte: "a" } }, "nocase");
    reject({ nick: "a" }, "unicode");
    reject({ nick: { $in: ["a"] } }, "unicode");
    // Not collation-sensitive → fine on a 'unicode' field too.
    expect(() =>
      buildMongoQuery({ nick: { $exists: true }, ticket: { $some: toTicket() } } as never, {
        collation: () => "unicode",
      }),
    ).not.toThrow();
  });

  it("predicate-free filters are untouched by the option (the read passes a collation instead)", () => {
    expect(mongoFilterStages({ nick: "A" }, nocaseSource)).toEqual([{ $match: { nick: "A" } }]);
  });
});

// ── Placement on each read path (real translation, recorded pipelines) ─────

let fx: Record<string, any>;
let space: DbSpace;
let calls: Array<{ method: string; args: unknown[] }>;

function fakeDb(): never {
  const collection = {
    aggregate: (...args: unknown[]) => {
      calls.push({ method: "aggregate", args });
      const cursor = {
        toArray: async () => [],
        batchSize: () => cursor,
        next: async () => null,
        close: async () => {},
      };
      return cursor;
    },
    find: (...args: unknown[]) => {
      calls.push({ method: "find", args });
      return { toArray: async () => [] };
    },
    countDocuments: async (...args: unknown[]) => {
      calls.push({ method: "countDocuments", args });
      return 0;
    },
  };
  return { databaseName: "fake", collection: () => collection } as never;
}

const lastPipeline = () =>
  calls.findLast((c) => c.method === "aggregate")!.args[0] as Array<Record<string, any>>;
const stageNames = (pipeline: Array<Record<string, unknown>>) =>
  pipeline.map((s) => Object.keys(s)[0]);
const issues = () => space.getTable(fx.RfIssue) as any;
const PREDICATE = { title: "t", ticket: { $some: { status: "open" } } };

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rel-filter.as");
});

beforeEach(() => {
  calls = [];
  const encryption = { defaultKeyId: "k1", keys: { k1: randomBytes(32) } };
  // One database handle: the tables share a store (predicates may correlate them).
  const db = fakeDb();
  space = new DbSpace(() => new MongoAdapter(db), { encryption });
});

describe("read paths switch to a pipeline only with predicates", () => {
  it("findMany: find() without, aggregate with; inner names are the target's physical ones", async () => {
    await issues().findMany({ filter: { title: "t" } });
    expect(calls.map((c) => c.method)).toEqual(["find"]);
    await issues().findMany({
      filter: { ticket: { $some: { teamId: "t1" } } },
      controls: { $sort: { id: 1 }, $skip: 1, $limit: 2, $select: ["title"] },
    });
    const pipeline = lastPipeline();
    expect(stageNames(pipeline)).toEqual([
      "$lookup",
      "$match",
      "$unset",
      "$sort",
      "$skip",
      "$limit",
      "$project",
    ]);
    expect(pipeline[0].$lookup.let).toEqual({ rf0k0: { $ifNull: ["$ticket_ref", null] } });
    expect(pipeline[0].$lookup.pipeline[2]).toEqual({ $match: { team_ref: "t1" } });
  });

  it("count: countDocuments without, $count stage with", async () => {
    await issues().count({ filter: { title: "t" } });
    expect(calls.map((c) => c.method)).toEqual(["countDocuments"]);
    await issues().count({ filter: PREDICATE });
    expect(stageNames(lastPipeline())).toEqual(["$match", "$lookup", "$match", "$unset", "$count"]);
  });

  it("findManyWithCount: filter stages before $facet", async () => {
    await issues().findManyWithCount({ filter: { title: "t" } });
    expect(stageNames(lastPipeline())).toEqual(["$match", "$facet"]);
    await issues().findManyWithCount({ filter: PREDICATE });
    expect(stageNames(lastPipeline())).toEqual(["$match", "$lookup", "$match", "$unset", "$facet"]);
  });

  it("grouped aggregate: predicate lookups before $group", async () => {
    await issues().aggregate({
      filter: PREDICATE,
      controls: {
        $groupBy: ["title"],
        $select: ["title", { $fn: "count", $field: "*", $as: "n" }],
      },
    });
    expect(stageNames(lastPipeline())).toEqual([
      "$match",
      "$lookup",
      "$match",
      "$unset",
      "$group",
      "$project",
    ]);
  });

  it("text search: after the leading $text match, before sort / limit", async () => {
    await issues().search("crash", { filter: PREDICATE, controls: {} });
    const pipeline = lastPipeline();
    expect(pipeline[0]).toEqual({ $match: { $text: { $search: "crash" } } });
    expect(stageNames(pipeline)).toEqual([
      "$match",
      "$addFields",
      "$match",
      "$lookup",
      "$match",
      "$unset",
      "$sort",
      "$limit",
    ]);
  });

  it("geo: $geoNear keeps the predicate-free part, predicates follow it", async () => {
    await issues().geoSearch([2, 48], { filter: PREDICATE, controls: {} });
    const pipeline = lastPipeline();
    expect(pipeline[0].$geoNear.query).toEqual({ title: "t" });
    expect(stageNames(pipeline)).toEqual(["$geoNear", "$lookup", "$match", "$unset", "$limit"]);
    await issues().geoSearch([2, 48], { filter: { title: "t" }, controls: {} });
    expect(lastPipeline()[0].$geoNear.query).toEqual({ title: "t" });
    expect(stageNames(lastPipeline())).toEqual(["$geoNear", "$limit"]);
  });

  it("mutations resolve _ids through the pipeline first", async () => {
    await issues().deleteMany(PREDICATE);
    expect(stageNames(lastPipeline())).toEqual([
      "$match",
      "$lookup",
      "$match",
      "$unset",
      "$project",
      "$sort",
    ]);
    expect(lastPipeline().slice(-2)).toEqual([{ $project: { _id: 1 } }, { $sort: { _id: 1 } }]);
  });

  it("supportsRelationFilters: read and write", () => {
    const adapter = new MongoAdapter(fakeDb());
    expect(adapter.supportsRelationFilters("read")).toBe(true);
    expect(adapter.supportsRelationFilters("write")).toBe(true);
  });
});
