import { randomBytes } from "node:crypto";

import { DbSpace } from "@atscript/db";
import type { Db, Document, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { MongoAdapter } from "../mongo-adapter";
import { prepareFixtures } from "./test-utils";

// Index use of the correlated `$lookup`s (predicates and native `$with`), since
// 0.1.147: the correlation `$expr` holds the bare `$eq` (an `$and` of `$eq`s
// for a composite key) and the NULL guard is a separate query-level `$match`,
// so each lookup is an index scan on the related collection's key — never a
// collection scan per source document. Verified with explain("executionStats")
// on the pipelines the adapter actually sends.

let server: any;
let client: MongoClient;
let db: Db;
let space: DbSpace;
let fx: Record<string, any>;

const TICKETS = 100;
const ISSUES_PER_TICKET = 10;
const CARDS = 100;

const T = (name: string) => space.getTable(fx[name]) as any;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rel-filter.as");
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const { MongoClient: MC } = await import("mongodb");
  server = await MongoMemoryServer.create();
  client = new MC(server.getUri());
  await client.connect();
  db = client.db("rel_filter_explain");
  space = new DbSpace(() => new MongoAdapter(db, client), {
    encryption: { defaultKeyId: "k1", keys: { k1: randomBytes(32) } },
  });

  const tickets = Array.from({ length: TICKETS }, (_, i) => ({
    key: `K${i}`,
    status: i % 2 ? "open" : "closed",
  }));
  await db.collection("rf_tickets").insertMany(tickets);
  await db.collection("rf_issues").insertMany(
    Array.from({ length: TICKETS * ISSUES_PER_TICKET }, (_, i) => ({
      id: i,
      title: `issue ${i}`,
      ticket_ref: `K${i % TICKETS}`,
    })),
  );
  await db
    .collection("rf_boards")
    .insertMany(
      Array.from({ length: 50 }, (_, i) => ({ org: `o${i % 5}`, code: `c${i}`, title: `b${i}` })),
    );
  await db.collection("rf_cards").insertMany(
    Array.from({ length: CARDS }, (_, i) => ({
      id: i,
      boardOrg: `o${i % 5}`,
      boardCode: `c${i % 50}`,
    })),
  );
  await db.collection("rf_tickets").createIndex({ key: 1 }, { name: "key_1" });
  await db.collection("rf_issues").createIndex({ ticket_ref: 1 }, { name: "ticket_ref_1" });
  await db.collection("rf_boards").createIndex({ org: 1, code: 1 }, { name: "org_1_code_1" });
}, 60_000);

afterAll(async () => {
  if (client) await client.close();
  if (server) await server.stop();
});

/** The aggregation pipelines `run` sends to `name`'s collection. */
async function pipelinesOf(name: string, run: () => Promise<unknown>): Promise<Document[][]> {
  const adapter = T(name).getAdapter() as MongoAdapter;
  const spy = vi.spyOn(adapter.collection, "aggregate");
  try {
    await run();
    return spy.mock.calls.map((call) => call[0] as Document[]);
  } finally {
    spy.mockRestore();
  }
}

/** The top-level `$lookup` stage stats of `pipeline` on `collection`. */
async function lookupStats(collection: string, pipeline: Document[]) {
  const explain = await db.collection(collection).aggregate(pipeline).explain("executionStats");
  const stages = (explain.stages ?? []) as Document[];
  const lookups = stages.filter((s) => s.$lookup);
  expect(lookups.length).toBeGreaterThan(0);
  return lookups.map((s) => ({
    docs: s.totalDocsExamined as number,
    keys: s.totalKeysExamined as number,
    collectionScans: s.collectionScans as number,
    indexes: ((s.indexesUsed ?? []) as string[]).toSorted(),
  }));
}

describe("MongoDB correlated $lookup index use", () => {
  it("predicate to: one index probe per source document", async () => {
    const [pipeline] = await pipelinesOf("RfIssue", () =>
      T("RfIssue").findMany({ filter: { ticket: { $some: { status: "open" } } } }),
    );
    const [stats] = await lookupStats("rf_issues", pipeline!);
    expect(stats).toMatchObject({ collectionScans: 0, indexes: ["key_1"] });
    // One ticket per issue (1,000 issues) — a collection scan per issue would examine 100,000.
    expect(stats!.docs).toBeLessThanOrEqual(TICKETS * ISSUES_PER_TICKET);
  });

  it("predicate from: index scan on the target's foreign key", async () => {
    const [pipeline] = await pipelinesOf("RfTicket", () =>
      T("RfTicket").findMany({ filter: { issues: { $none: { title: "nope" } } } }),
    );
    const [stats] = await lookupStats("rf_tickets", pipeline!);
    expect(stats).toMatchObject({ collectionScans: 0, indexes: ["ticket_ref_1"] });
    expect(stats!.docs).toBeLessThanOrEqual(TICKETS * ISSUES_PER_TICKET);
  });

  it("predicate on a composite key: the compound index", async () => {
    const [pipeline] = await pipelinesOf("RfCard", () =>
      T("RfCard").findMany({ filter: { board: { $some: { title: { $ne: "x" } } } } }),
    );
    const [stats] = await lookupStats("rf_cards", pipeline!);
    expect(stats).toMatchObject({ collectionScans: 0, indexes: ["org_1_code_1"] });
    expect(stats!.docs).toBeLessThanOrEqual(CARDS);
  });

  it("$with to / from loads use the same indexes", async () => {
    const toPipeline = (
      await pipelinesOf("RfIssue", () =>
        T("RfIssue").findMany({ filter: {}, controls: { $with: [{ name: "ticket" }] } }),
      )
    ).find((p) => p.some((s) => s.$lookup));
    const [to] = await lookupStats("rf_issues", toPipeline!);
    expect(to).toMatchObject({ collectionScans: 0, indexes: ["key_1"] });
    expect(to!.docs).toBeLessThanOrEqual(TICKETS * ISSUES_PER_TICKET);

    const fromPipeline = (
      await pipelinesOf("RfTicket", () =>
        T("RfTicket").findMany({ filter: {}, controls: { $with: [{ name: "issues" }] } }),
      )
    ).find((p) => p.some((s) => s.$lookup));
    const [from] = await lookupStats("rf_tickets", fromPipeline!);
    expect(from).toMatchObject({ collectionScans: 0, indexes: ["ticket_ref_1"] });
    expect(from!.docs).toBe(TICKETS * ISSUES_PER_TICKET);
  });
});
