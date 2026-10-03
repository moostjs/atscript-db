import { randomBytes } from "node:crypto";

import { DbError, DbSpace, ResolvedRelationFilter } from "@atscript/db";
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

const guardedJoin = (prefix: string, inner: string) => ({
  $match: {
    $expr: { $and: [{ $ne: [`$$${prefix}k0`, null] }, { $eq: [`$${inner}`, `$$${prefix}k0`] }] },
  },
});
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
            pipeline: [guardedJoin("rf0", "key"), { $match: { status: "open" } }, ...exists],
            as: "__rf0",
          },
        },
      ],
      match: { __rf0: { $ne: [] } },
      temp: ["__rf0"],
    });
    const none = buildMongoQuery({ ticket: { $none: toTicket() } } as never);
    expect(none.match).toEqual({ __rf0: { $size: 0 } });
    // `{}` operand: correlation only
    expect(none.lookups[0].$lookup.pipeline).toEqual([guardedJoin("rf0", "key"), ...exists]);
  });

  it("composite keys: one guard + equality per pair", () => {
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
    expect(lookups[0].$lookup.pipeline[0]).toEqual({
      $match: {
        $expr: {
          $and: [
            { $ne: ["$$rf0k0", null] },
            { $eq: ["$org", "$$rf0k0"] },
            { $ne: ["$$rf0k1", null] },
            { $eq: ["$code", "$$rf0k1"] },
          ],
        },
      },
    });
  });

  it("splits predicate-free top-level conjuncts into a pre-match", () => {
    const plan = buildMongoQuery({
      title: "x",
      $and: [{ id: { $gt: 1 } }, { ticket: { $some: toTicket() } }],
      $or: [{ id: 4 }, { ticket: { $none: toTicket() } }],
    } as never);
    expect(plan.pre).toEqual({ $and: [{ title: "x" }, { id: { $gt: 1 } }] });
    expect(plan.match).toEqual({
      $and: [{ __rf0: { $ne: [] } }, { $or: [{ id: 4 }, { __rf1: { $size: 0 } }] }],
    });
    expect(plan.temp).toEqual(["__rf0", "__rf1"]);
  });

  it("$not around a predicate", () => {
    const plan = buildMongoQuery({ $not: { ticket: { $some: toTicket() } } } as never);
    expect(plan.match).toEqual({ $nor: [{ __rf0: { $ne: [] } }] });
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
      guardedJoin("rf0", "key"),
      { $match: { status: "open" } },
      {
        $lookup: {
          from: "rf_teams",
          let: { rf1k0: { $ifNull: ["$team_ref", null] } },
          pipeline: [guardedJoin("rf1", "id"), { $match: { name: "Core" } }, ...exists],
          as: "__rf1",
        },
      },
      { $match: { __rf1: { $ne: [] } } },
      ...exists,
    ]);
    // Only the outer temp field is dropped — inner documents are projected to `_id`.
    expect(plan.temp).toEqual(["__rf0"]);
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
            guardedJoin("rf0", "ticketKey"),
            { $match: { pinned: true } },
            {
              $lookup: {
                from: "rf_labels",
                let: { rf1k0: { $ifNull: ["$labelId", null] } },
                pipeline: [guardedJoin("rf1", "id"), { $match: { label_name: "bug" } }, ...exists],
                as: "__rf1",
              },
            },
            { $match: { __rf1: { $ne: [] } } },
            ...exists,
          ],
          as: "__rf0",
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
    expect(stages[3]).toEqual({ $unset: ["__rf0"] });
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

// ── Placement on each read path (real translation, recorded pipelines) ─────

let fx: Record<string, any>;
let space: DbSpace;
let calls: Array<{ method: string; args: unknown[] }>;

function fakeDb(): never {
  const collection = {
    aggregate: (...args: unknown[]) => {
      calls.push({ method: "aggregate", args });
      return { toArray: async () => [] };
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
  return { collection: () => collection } as never;
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
  space = new DbSpace(() => new MongoAdapter(fakeDb()), { encryption });
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
    expect(pipeline[0].$lookup.pipeline[1]).toEqual({ $match: { team_ref: "t1" } });
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
    ]);
    expect(lastPipeline().at(-1)).toEqual({ $project: { _id: 1 } });
  });

  it("supportsRelationFilters: read and write", () => {
    const adapter = new MongoAdapter(fakeDb());
    expect(adapter.supportsRelationFilters("read")).toBe(true);
    expect(adapter.supportsRelationFilters("write")).toBe(true);
  });
});
