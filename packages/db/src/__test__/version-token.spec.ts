import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import type { FilterExpr } from "@uniqu/core";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DbError } from "../db-error";
import { $cas } from "../ops";
import dbPlugin from "../plugin";
import { computeTableHash, computeTableSnapshot } from "../schema/schema-hash";
import { DbSpace } from "../table/db-space";
import type { TDbUpdateOptions, TDbUpdateResult } from "../types";
import { withOptimisticRetry } from "../with-optimistic-retry";
import { MockAdapter, matchesFilter, prepareFixtures } from "./test-utils";

/**
 * `@db.column.version.token` (since 0.1.196): the `@db.column.version` field
 * holds an opaque string the store issues — for a store that hands out its
 * own row version. Valid only on an adapter that declares
 * `supportsVersionTokens()`.
 */

async function diagnosticsFor(source: string): Promise<string[]> {
  const rootDir = mkdtempSync(join(tmpdir(), "version-token-"));
  writeFileSync(join(rootDir, "fixture.as"), source);
  const repo = await build({ rootDir, entries: ["fixture.as"], plugins: [tsPlugin(), dbPlugin()] });
  return [...(await repo.diagnostics()).values()].flat().map((m) => m.message);
}

function table(fields: string): string {
  return `
    @db.table 'vt_docs'
    export interface VtDoc {
      @meta.id
      id: number
      title: string
      ${fields}
    }
  `;
}

describe("compile rules", () => {
  it("a string version field with the modifier compiles", async () => {
    expect(
      await diagnosticsFor(table("@db.column.version\n@db.column.version.token\netag: string")),
    ).toEqual([]);
  });

  it("the modifier needs @db.column.version on the same field", async () => {
    expect(await diagnosticsFor(table("@db.column.version.token\netag: string"))).toEqual([
      "@db.column.version.token requires @db.column.version on the same field",
    ]);
  });

  it("the modifier needs a string field", async () => {
    expect(
      await diagnosticsFor(
        table("@db.column.version\n@db.column.version.token\nversion: number.int"),
      ),
    ).toEqual(['@db.column.version.token is not compatible with type "number" — requires string']);
  });

  it("a token field takes no @db.default*", async () => {
    expect(
      await diagnosticsFor(
        table("@db.column.version\n@db.column.version.token\n@db.default 'x'\netag: string"),
      ),
    ).toEqual([
      "@db.column.version.token cannot coexist with @db.default — a token is issued by the store",
    ]);
  });

  it("a token table takes no @db.column.version.exempt, nested fields included", async () => {
    const messages = await diagnosticsFor(
      table(`@db.column.version
      @db.column.version.token
      etag: string
      @db.column.version.exempt
      score: number
      stats: {
        @db.column.version.exempt
        hits: number
      }`),
    );
    const refusal =
      "@db.column.version.exempt cannot sit on a table whose version is a @db.column.version.token — a token is issued by the store";
    expect(messages).toEqual([refusal, refusal]);
  });

  it("the other version rules stay: optional, one per table", async () => {
    const messages = await diagnosticsFor(
      table(`@db.column.version
      @db.column.version.token
      etag?: string`),
    );
    expect(messages).toEqual([
      "@db.column.version requires a non-optional field — version columns are always populated (default 0)",
    ]);
  });
});

// ── Run time ────────────────────────────────────────────────────────────────

let VtTicket: any;
let VtCounter: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ VtTicket, VtCounter } = await import("./fixtures/version-token.as"));
});

type TRow = Record<string, unknown>;

/**
 * A store that issues its own row version: it fills the token on insert,
 * moves it on every write and matches `expectedVersion` by equality.
 */
class TokenAdapter extends MockAdapter {
  private _issued = 0;

  override supportsVersionTokens(): boolean {
    return true;
  }

  private _token(): string {
    return `W/"${++this._issued}"`;
  }

  private _col(): string {
    return this._table.versionColumnPhysical!;
  }

  override async insertMany(data: TRow[]) {
    return super.insertMany(data.map((row) => ({ ...row, [this._col()]: this._token() })));
  }

  private _write(filter: FilterExpr, expected: unknown, apply: (row: TRow) => void) {
    const row = this._rows().find(
      (r) => matchesFilter(r, filter) && (expected === undefined || r[this._col()] === expected),
    );
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    apply(row);
    row[this._col()] = this._token();
    return { matchedCount: 1, modifiedCount: 1 };
  }

  override async updateOne(
    filter: FilterExpr,
    data: TRow,
    ops?: unknown,
    expectedVersion?: number | string,
    opts?: TDbUpdateOptions,
  ): Promise<TDbUpdateResult> {
    this.record("updateOne", filter, data, ops, expectedVersion, opts);
    return this._write(filter, expectedVersion, (row) => Object.assign(row, data));
  }

  override async replaceOne(
    filter: FilterExpr,
    data: TRow,
    expectedVersion?: number | string,
  ): Promise<TDbUpdateResult> {
    this.record("replaceOne", filter, data, expectedVersion);
    return this._write(filter, expectedVersion, (row) => Object.assign(row, data));
  }

  /** What `_versionColumnFor` answers on this table. */
  bumpColumn(opts?: TDbUpdateOptions): string | undefined {
    return this._versionColumnFor(opts);
  }
}

function tokenTable() {
  let adapter!: TokenAdapter;
  const table = new DbSpace(() => (adapter = new TokenAdapter())).getTable(VtTicket);
  table.getMetadata();
  return { table, adapter };
}

async function rejection(run: () => Promise<unknown>): Promise<DbError> {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DbError);
  return error as DbError;
}

describe("a token table on an adapter that supports version tokens", () => {
  it("round trip: the store fills the token on insert; a $cas write with it applies and moves it", async () => {
    const { table, adapter } = tokenTable();
    // no implicit `0` default: the token is the store's
    expect(table.getMetadata().defaults.has("etag")).toBe(false);
    await table.insertOne({ id: 1, title: "first" } as any);
    const row = (await table.findById(1)) as TRow;
    expect(row.etag).toBe('W/"1"');

    const result = await table.updateOne({ id: 1, title: "second", ...$cas("etag", 'W/"1"') });
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    const call = adapter.calls.findLast((c) => c.method === "updateOne")!;
    expect(call.args[1]).toEqual({ title: "second" });
    expect(call.args[3]).toBe('W/"1"');
    // the core never bumps a token: the adapter sees no version column to bump
    expect(call.args[4]).toBeUndefined();
    expect(adapter.bumpColumn()).toBeUndefined();
    expect(((await table.findById(1)) as TRow).etag).toBe('W/"2"');
  });

  it("mismatch: a stale token matches nothing", async () => {
    const { table } = tokenTable();
    await table.insertOne({ id: 1, title: "first" } as any);
    await table.updateOne({ id: 1, title: "second" } as any);
    expect(await table.updateOne({ id: 1, title: "third", $cas: { etag: 'W/"1"' } })).toEqual({
      matchedCount: 0,
      modifiedCount: 0,
    });
    expect(await table.replaceOne({ id: 1, title: "x", $cas: { etag: 'W/"1"' } } as any)).toEqual({
      matchedCount: 0,
      modifiedCount: 0,
    });
    expect(await table.replaceOne({ id: 1, title: "x", $cas: { etag: 'W/"2"' } } as any)).toEqual({
      matchedCount: 1,
      modifiedCount: 1,
    });
  });

  it("bulkUpdate carries a token per item; withOptimisticRetry round-trips one", async () => {
    const { table, adapter } = tokenTable();
    await table.insertMany([
      { id: 1, title: "a" },
      { id: 2, title: "b" },
    ] as any);
    const result = await table.bulkUpdate([
      { id: 1, title: "a2", $cas: { etag: 'W/"1"' } },
      { id: 2, title: "b2", $cas: { etag: "stale" } },
    ]);
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    const expected = adapter.calls.filter((c) => c.method === "updateOne").map((c) => c.args[3]);
    expect(expected).toEqual(['W/"1"', "stale"]);

    await withOptimisticRetry(table, { id: 2 }, () => ({ title: "b3" }));
    expect(((await table.findById(2)) as TRow).title).toBe("b3");
  });

  it("$cas takes a non-empty string — a number or '' is refused", async () => {
    const { table } = tokenTable();
    for (const value of [3, ""]) {
      const error = await rejection(() =>
        table.updateOne({ id: 1, title: "x", $cas: { etag: value } } as any),
      );
      expect(error.code).toBe("INVALID_QUERY");
      expect(error.errors).toEqual([
        {
          path: "$cas.etag",
          message: '$cas operator: value for "etag" must be a non-empty string (a version token)',
        },
      ]);
    }
  });

  it("a patch that writes no column of its row (key and $cas only) is refused with NOT_SUPPORTED", async () => {
    const { table, adapter } = tokenTable();
    await table.insertOne({ id: 1, title: "first" } as any);
    const error = await rejection(() => table.updateOne({ id: 1, $cas: { etag: 'W/"1"' } }));
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.errors).toEqual([
      {
        path: "$cas",
        message:
          'A patch that writes no column of its row (key, $cas and relation data only) is a versioned touch, which increments a counter; "etag" is a version token issued by the store',
      },
    ]);
    expect(adapter.calls.some((c) => c.method === "updateOne")).toBe(false);
  });

  it("bulkUpdate: a refused touch item stops the batch before any item is written", async () => {
    const { table, adapter } = tokenTable();
    await table.insertMany([
      { id: 1, title: "a" },
      { id: 2, title: "b" },
    ] as any);
    const error = await rejection(() =>
      table.bulkUpdate([
        { id: 1, title: "a2", $cas: { etag: 'W/"1"' } },
        { id: 2, $cas: { etag: 'W/"2"' } },
      ]),
    );
    expect(error.code).toBe("NOT_SUPPORTED");
    // the memory-style adapter's withTransaction is a passthrough: nothing ran
    expect(adapter.calls.some((c) => c.method === "updateOne")).toBe(false);
    expect(((await table.findById(1)) as TRow).title).toBe("a");
  });

  it("touchMany is refused with NOT_SUPPORTED", async () => {
    const { table } = tokenTable();
    const error = await rejection(() => table.touchMany([{ id: 1, etag: 'W/"1"' }] as any));
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toContain("touchMany increments a counter");
  });

  it("the modifier is not part of the schema snapshot", () => {
    const hashOf = (metadata: Array<[string, unknown]>) => {
      const type = obj({ id: idf(), etag: leaf("string", metadata) }, [["db.table", "vt_hash"]]);
      const t = new DbSpace(() => new TokenAdapter()).getTable(type);
      return computeTableHash(computeTableSnapshot(t, (f) => f.designType.toUpperCase()));
    };
    expect(hashOf([...TOKEN])).toBe(hashOf([]));
  });
});

describe("refusals", () => {
  it("build: a token table on an adapter without version tokens refuses every use", async () => {
    const table = new DbSpace(() => new MockAdapter()).getTable(VtTicket);
    const refusal =
      'Table "vt_tickets": version column "etag" is a @db.column.version.token; the MockAdapter adapter does not support version tokens';
    expect(() => table.getMetadata()).toThrow(refusal);
    await expect(table.findMany({})).rejects.toThrow(refusal);
  });

  it("an integer version column still refuses a string $cas", async () => {
    const table = new DbSpace(() => new TokenAdapter()).getTable(VtCounter);
    const error = await rejection(() =>
      table.updateOne({ id: 1, title: "x", $cas: { version: "4" } }),
    );
    expect(error.errors).toEqual([
      { path: "$cas.version", message: '$cas operator: value for "version" must be an integer' },
    ]);
  });

  it("run time: a @db.default* on the token field", () => {
    expect(() =>
      buildRaw({ id: idf(), etag: leaf("string", [...TOKEN, ["db.default", "x"]]) }),
    ).toThrow(
      '@db.column.version.token on "etag" cannot coexist with @db.default* — a token is issued by the store',
    );
  });

  it("run time: a @db.column.version.exempt field on the table", () => {
    expect(() =>
      buildRaw({
        id: idf(),
        etag: leaf("string", TOKEN),
        score: leaf("number", [["db.column.version.exempt", true]]),
      }),
    ).toThrow(
      '@db.column.version.exempt on "score": the version "etag" is a @db.column.version.token — a token is issued by the store',
    );
  });
});

// Pre-compiled models: the runtime mirror of the compile rules.

function leaf(designType: string, metadata: Array<[string, unknown]> = []) {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "", designType, tags: new Set<string>() },
    metadata: new Map(metadata),
  } as any;
}
function obj(props: Record<string, any>, metadata: Array<[string, unknown]> = []) {
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "object", props: new Map(Object.entries(props)) },
    metadata: new Map(metadata),
  } as any;
}
const TOKEN: Array<[string, unknown]> = [
  ["db.column.version", true],
  ["db.column.version.token", true],
];
const idf = () => leaf("number", [["meta.id", true]]);
let seq = 0;
function buildRaw(props: Record<string, any>) {
  const type = obj(props, [["db.table", `vt_raw_${seq++}`]]);
  return new DbSpace(() => new TokenAdapter()).getTable(type).getMetadata();
}
