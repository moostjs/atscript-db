import { DbError, UniquSelect } from "@atscript/db";
import type { AtscriptDbTable, DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { MemoryAdapter, setMemoryProvider } from "../memory-adapter";
import type { MemoryProviderFn } from "../memory-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Populated after fixtures compile.
let Job: any;

/** A row shaped like the `Job` fixture. */
function job(over: Record<string, unknown>): Record<string, unknown> {
  return { scheduled: true, age: 0, ...over };
}

/**
 * Asserts that `op` rejects with the read-only guard's DbError: code
 * INVALID_QUERY (a 4xx via moost-db's validation interceptor) and a message
 * that names the offending table ("jobs").
 */
async function expectReadOnly(op: () => Promise<unknown>): Promise<void> {
  let err: unknown;
  try {
    await op();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(DbError);
  expect((err as DbError).code).toBe("INVALID_QUERY");
  expect((err as DbError).message).toContain("jobs");
  expect((err as DbError).message).toContain("read-only");
}

describe("MemoryAdapter provider (read-through) mode", () => {
  let space: DbSpace;

  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/stored.as");
    Job = fixtures.Job;
  });

  // Fresh space (⇒ fresh adapter) per test for isolation.
  beforeEach(() => {
    space = createTestSpace();
  });

  /**
   * Installs `fn` as Job's provider and returns the resolved handles: the memory
   * adapter (for direct-adapter reads/writes) and the table (for the consumer
   * path). Collapses the repeated `setMemoryProvider(space, Job, fn)` + typed
   * `getAdapter`/`getTable` casts every provider-mode test otherwise repeats.
   */
  function provideJobs(fn: MemoryProviderFn): {
    adapter: MemoryAdapter;
    table: AtscriptDbTable;
  } {
    setMemoryProvider(space, Job, fn);
    return {
      adapter: space.getAdapter(Job) as MemoryAdapter,
      table: space.getTable(Job) as AtscriptDbTable,
    };
  }

  // WHY: the whole point of provider mode — rows come from a runtime closure
  // recomputed per read, so mutating the source between reads is observed with
  // no caching.
  it("recomputes rows per read (mutating the source is reflected on the next read)", async () => {
    const source: Array<Record<string, unknown>> = [
      job({ jobName: "a", age: 1 }),
      job({ jobName: "b", age: 2 }),
    ];
    const { table: jobs } = provideJobs(() => source);

    const first = (await jobs.findMany({ filter: {}, controls: {} })) as any[];
    expect(first.map((r) => r.jobName)).toEqual(["a", "b"]);

    // Add a row to the backing source — the next read must see it (no cache).
    source.push(job({ jobName: "c", age: 3 }));
    const second = (await jobs.findMany({ filter: {}, controls: {} })) as any[];
    expect(second.map((r) => r.jobName)).toEqual(["a", "b", "c"]);

    // Remove rows — reflected too.
    source.splice(0, source.length, job({ jobName: "z", age: 9 }));
    const third = (await jobs.findMany({ filter: {}, controls: {} })) as any[];
    expect(third.map((r) => r.jobName)).toEqual(["z"]);
  });

  // WHY: a single logical read must invoke the provider EXACTLY once. For
  // findManyWithCount this is the load-bearing guarantee — count and data derive
  // from ONE snapshot, so they can never disagree.
  it("invokes the provider exactly once per findMany / count / findManyWithCount", async () => {
    let calls = 0;
    const snapshot = [job({ jobName: "a", age: 1 }), job({ jobName: "b", age: 2 })];
    const fn: MemoryProviderFn = () => {
      calls++;
      return snapshot;
    };
    const { adapter } = provideJobs(fn);

    calls = 0;
    await adapter.findMany({ filter: {}, controls: {} });
    expect(calls).toBe(1);

    calls = 0;
    await adapter.count({ filter: {}, controls: {} });
    expect(calls).toBe(1);

    // The critical one: a SINGLE provider call feeds both count and data.
    calls = 0;
    await adapter.findManyWithCount({ filter: {}, controls: {} });
    expect(calls).toBe(1);

    calls = 0;
    await adapter.findOne({ filter: {}, controls: {} });
    expect(calls).toBe(1);
  });

  // WHY: proves the single-snapshot override concretely — a provider that
  // returns a DIFFERENT-length array on each call would make count and data
  // disagree if they each triggered a provider call. One call ⇒ they agree.
  it("findManyWithCount derives count and data from ONE snapshot", async () => {
    let calls = 0;
    const rows = [
      job({ jobName: "a", age: 1 }),
      job({ jobName: "b", age: 2 }),
      job({ jobName: "c", age: 3 }),
    ];
    // Each call returns a longer slice; a second call within one read would be
    // observable as a count/data mismatch.
    const { adapter } = provideJobs(() => rows.slice(0, ++calls));

    calls = 0;
    const { data, count } = await adapter.findManyWithCount({
      filter: {},
      controls: { $limit: 1 },
    });
    expect(calls).toBe(1); // provider invoked exactly once
    expect(count).toBe(1); // full filtered total of the SAME snapshot (1 row)
    expect((data as any[]).length).toBe(1);
  });

  // WHY: the filter/sort/paginate/project read pipeline runs unchanged over the
  // provider snapshot — provider mode only swaps the row source.
  it("filters, sorts, paginates and projects over the provider snapshot", async () => {
    const source = [
      job({ jobName: "a", scheduled: true, age: 30 }),
      job({ jobName: "b", scheduled: false, age: 40 }),
      job({ jobName: "c", scheduled: true, age: 10 }),
      job({ jobName: "d", scheduled: true, age: 20 }),
    ];
    const { adapter } = provideJobs(() => source);

    // scheduled:true → a,c,d ; sort by age asc → c(10),d(20),a(30) ; skip 1 →
    // d,a ; limit 1 → d ; inclusion project → jobName (+ pk) only.
    const { data, count } = await adapter.findManyWithCount({
      filter: { scheduled: true },
      controls: {
        $sort: { age: 1 },
        $skip: 1,
        $limit: 1,
        $select: new UniquSelect({ jobName: 1 }),
      },
    });
    expect(count).toBe(3); // full filtered total (scheduled:true), pre-pagination
    expect(data).toEqual([{ jobName: "d" }]); // pk auto-included; age/scheduled excluded
  });

  // WHY: reads clone on OUTPUT, so a provider that hands back objects it still
  // holds is protected — mutating a returned row cannot corrupt the source.
  it("does not mutate objects the provider hands back (clone-on-output)", async () => {
    const held = job({ jobName: "a", age: 5, nested: { v: 1 } });
    const { adapter } = provideJobs(() => [held]);

    const rows = (await adapter.findMany({ filter: {}, controls: {} })) as any[];
    rows[0].age = 999;
    rows[0].nested.v = 999;

    // The held source object is untouched.
    expect((held as any).age).toBe(5);
    expect((held as any).nested.v).toBe(1);
  });

  // WHY: a provider-backed table is READ-ONLY — every one of the 8 write methods
  // must reject with the guard's DbError. Table-driven for the common trio,
  // adapter-driven for the remainder.
  it("rejects all 8 write methods with a read-only DbError (4xx)", async () => {
    const { adapter, table: jobs } = provideJobs(() => [job({ jobName: "a", age: 1 })]);

    // Through the table (payloads are valid so validation passes and the write
    // reaches the adapter guard).
    await expectReadOnly(() => jobs.insertOne(job({ jobName: "x", age: 2 }) as any));
    await expectReadOnly(() => jobs.updateOne({ jobName: "a", scheduled: false } as any));
    await expectReadOnly(() => jobs.deleteOne("a" as any));

    // Through the adapter directly (the remaining five).
    await expectReadOnly(() => adapter.insertMany([job({ jobName: "y", age: 3 })]));
    await expectReadOnly(() => adapter.updateMany({ jobName: "a" }, { scheduled: false }));
    await expectReadOnly(() =>
      adapter.replaceOne({ jobName: "a" }, job({ jobName: "a", scheduled: false, age: 9 })),
    );
    await expectReadOnly(() => adapter.replaceMany({ jobName: "a" }, { scheduled: false }));
    await expectReadOnly(() => adapter.deleteMany({ jobName: "a" }));
  });

  // WHY: the ergonomic helper resolves the already-built adapter and installs the
  // provider (positive path). The instanceof guard protects the negative path.
  it("setMemoryProvider installs a provider on the memory-backed table", async () => {
    setMemoryProvider(space, Job, () => [job({ jobName: "a", age: 1 })]);
    const jobs = space.getTable(Job) as AtscriptDbTable;
    const rows = (await jobs.findMany({ filter: {}, controls: {} })) as any[];
    expect(rows.map((r) => r.jobName)).toEqual(["a"]);

    // The resolved adapter is a MemoryAdapter (what the helper's guard checks);
    // a non-memory adapter would make setMemoryProvider throw.
    expect(space.getAdapter(Job)).toBeInstanceOf(MemoryAdapter);
  });

  // WHY: stored mode must be untouched when no provider is set — the adapter
  // still reads/writes its instance Map.
  it("leaves stored mode intact when no provider is set", async () => {
    const jobs = space.getTable(Job) as AtscriptDbTable;
    const adapter = space.getAdapter(Job) as MemoryAdapter;
    await adapter.ensureTable();
    await adapter.syncIndexes();

    await jobs.insertOne(job({ jobName: "a", age: 1 }) as any);
    const rows = (await jobs.findMany({ filter: {}, controls: {} })) as any[];
    expect(rows.map((r) => r.jobName)).toEqual(["a"]);
  });
});
