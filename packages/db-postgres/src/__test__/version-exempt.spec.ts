import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import { AtscriptDbTable } from "@atscript/db";

import { PostgresAdapter } from "../postgres-adapter";

import { prepareFixtures, createMockDriver } from "./test-utils";

let VxRecord: any;

const Q = (c: string) => '"' + c + '"';

// `@db.column.version.exempt` (since 0.1.150) — recording-driver SQL assertions.
describe("PostgresAdapter version-exempt patches", () => {
  let driver: ReturnType<typeof createMockDriver>;
  let table: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    VxRecord = (await import("./fixtures/version-exempt.as")).VxRecord;
  });

  const make = (runResult?: Record<string, number>) => {
    driver = createMockDriver({ getResult: { cnt: 1 }, runResult: runResult as any });
    table = new AtscriptDbTable(VxRecord, new PostgresAdapter(driver));
  };
  beforeEach(() => make());

  const updates = () =>
    driver.calls.filter((c) => c.method === "run" && c.sql.startsWith("UPDATE"));

  it("exempt-only updateOne: no bump, no version predicate", async () => {
    await table.updateOne({ id: 1, score: 5 } as any);
    const [call] = updates();
    expect(call!.sql).toMatch(new RegExp(`SET ${Q("score")} = \\$\\d WHERE`));
    expect(call!.sql).not.toContain(Q("version"));
    expect(call!.params).toEqual([5, 1]);
  });

  it("mixed updateOne bumps", async () => {
    await table.updateOne({ id: 1, score: 5, title: "t" } as any);
    expect(updates()[0]!.sql).toContain(`${Q("version")} = ${Q("version")} + 1`);
  });

  it("$cas + exempt-only bumps and checks", async () => {
    await table.updateOne({ id: 1, score: 5, $cas: { version: 4 } } as any);
    const [call] = updates();
    expect(call!.sql).toContain(`${Q("version")} = ${Q("version")} + 1`);
    expect(call!.sql).toMatch(new RegExp(`AND ${Q("version")} = \\$\\d`));
    expect(call!.params).toContain(4);
  });

  it("updateMany: exempt-only no bump, mixed bumps", async () => {
    await table.updateMany({ status: "open" } as any, { score: 1 } as any);
    expect(updates()[0]!.sql).not.toContain(Q("version"));
    await table.updateMany({ status: "open" } as any, { title: "x" } as any);
    expect(updates()[1]!.sql).toContain(`${Q("version")} = ${Q("version")} + 1`);
  });

  it("nested exempt object flattens without a bump", async () => {
    await table.updateOne({ id: 1, metrics: { impact: 2 } } as any);
    const [call] = updates();
    expect(call!.sql).toContain(Q("metrics__impact"));
    expect(call!.sql).not.toContain(`${Q("version")} =`);
  });

  it("replaceOne still bumps", async () => {
    await table.replaceOne({
      id: 1,
      title: "t",
      status: "s",
      score: 1,
      hits: 1,
      metrics: { impact: 1 },
      tags: [],
    } as any);
    expect(updates()[0]!.sql).toContain(`${Q("version")} = ${Q("version")} + 1`);
  });
});
