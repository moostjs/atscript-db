import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterEach } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { SqliteAdapter } from "../sqlite-adapter";
import { BetterSqlite3Driver } from "../better-sqlite3-driver";
import { caught, expectLockTimeout, prepareFixtures, RecordingDriver } from "./test-utils";

// Since 0.1.178 a vector is stored as a Float32 BLOB (host byte order, sqlite-vec's
// compact form) when sqlite-vec is loaded — before, every write stored JSON
// text in the BLOB-declared column, because the mapper serializes
// json-storage fields before the formatter runs. Rows written before stay
// JSON text: reads accept both, nothing is rewritten, and the vec0 index
// takes both.

let sqliteVecAvailable = true;
try {
  new BetterSqlite3Driver(":memory:", { vector: true }).close();
} catch {
  sqliteVecAvailable = false;
}
const vecDescribe = sqliteVecAvailable ? describe : describe.skip;

let fx: Record<string, any>;
let driver: BetterSqlite3Driver;
let dir: string | undefined;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/vector-storage.as");
});

afterEach(() => {
  try {
    driver?.close();
  } catch {
    // already closed
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** `v` as it reads back from a Float32 BLOB. */
const f32 = (v: number[]) => Array.from(new Float32Array(v));

/** `rows` ordered by `id`. */
const byId = <T extends { id: string }>(rows: T[]) =>
  rows.toSorted((a, b) => a.id.localeCompare(b.id));

/** Each row's storage class of `embedding` (`blob`, `text`, `null`). */
const storage = (table = "vs_docs", column = "embedding") =>
  Object.fromEntries(
    driver
      .all<{ id: string; t: string }>(`SELECT id, typeof("${column}") AS t FROM "${table}"`)
      .map((r) => [r.id, r.t]),
  );

/** A row as a version before 0.1.178 wrote it: the vector as JSON text. */
const writeOld = (id: string, embedding: number[]) =>
  driver.run(`INSERT INTO vs_docs (id, title, embedding) VALUES (?, 'old', ?)`, [
    id,
    JSON.stringify(embedding),
  ]);

async function open(options: { vector?: boolean; file?: string; sync?: unknown[] } = {}) {
  driver = new BetterSqlite3Driver(options.file ?? ":memory:", { vector: options.vector ?? true });
  const space = new DbSpace(() => new SqliteAdapter(driver));
  const result = await new SchemaSync(space).run((options.sync ?? [fx.VsDoc]) as never[], {
    force: true,
    onError: "silent",
  });
  const docs = space.getTable(fx.VsDoc) as any;
  return { space, docs, adapter: docs.dbAdapter as SqliteAdapter, result };
}

/** The ids `vectorSearch` returns for `vector`, nearest first. */
async function nearest(adapter: SqliteAdapter, vector: number[]): Promise<string[]> {
  const rows = await adapter.vectorSearch(vector, { filter: {}, controls: {} } as never);
  return rows.map((r) => r.id as string);
}

vecDescribe("[sqlite] vectors are stored as Float32 BLOBs (real sqlite-vec)", () => {
  const v = [0.1, 0.2, 0.3, 0.4];

  it("every write path stores a Float32 BLOB that reads back as float32 numbers", async () => {
    const { docs } = await open();
    await docs.insertOne({ id: "one", title: "t", embedding: v });
    await docs.insertMany([
      { id: "m1", title: "t", embedding: v },
      { id: "m2", title: "t", embedding: v },
    ]);
    await docs.insertOne({ id: "ign", title: "t", embedding: v }, { onConflict: "ignore" });
    await docs.insertOne({ id: "rep", title: "t" });
    await docs.replaceOne({ id: "rep", title: "t2", embedding: v });
    await docs.insertOne({ id: "upd", title: "t" });
    await docs.updateOne({ id: "upd", embedding: v });
    await docs.insertOne({ id: "many", title: "bulk" });
    await docs.updateMany({ title: "bulk" }, { embedding: v });

    const ids = ["one", "m1", "m2", "ign", "rep", "upd", "many"];
    expect(storage()).toEqual(Object.fromEntries(ids.map((id) => [id, "blob"])));
    expect(
      driver.get<{ n: number }>(`SELECT length(embedding) AS n FROM vs_docs WHERE id = 'one'`),
    ).toEqual({ n: 16 });
    for (const id of ids) {
      expect((await docs.findById(id)).embedding, id).toEqual(f32(v));
    }
  });

  it("null and absent stay NULL", async () => {
    const { docs } = await open();
    await docs.insertOne({ id: "absent", title: "t" });
    await docs.insertOne({ id: "nulled", title: "t", embedding: v });
    await docs.updateOne({ id: "nulled", embedding: null });
    expect(storage()).toEqual({ absent: "null", nulled: "null" });
  });

  it("reads accept JSON-text rows next to Float32 rows: find, $select, $exists", async () => {
    const { docs } = await open();
    writeOld("old", [1, 0.5, 0, 0]);
    await docs.insertOne({ id: "new", title: "t", embedding: v });
    await docs.insertOne({ id: "none", title: "t" });
    expect(storage()).toEqual({ old: "text", new: "blob", none: "null" });

    expect((await docs.findById("old")).embedding).toEqual([1, 0.5, 0, 0]);
    const selected = await docs.findMany({
      filter: { id: { $in: ["old", "new"] } },
      controls: { $select: ["id", "embedding"], $sort: { id: 1 } },
    });
    expect(selected).toEqual([
      { id: "new", embedding: f32(v) },
      { id: "old", embedding: [1, 0.5, 0, 0] },
    ]);
    const present = await docs.findMany({
      filter: { embedding: { $exists: true } },
      controls: { $sort: { id: 1 } },
    });
    expect(present.map((r: any) => r.id)).toEqual(["new", "old"]);
  });

  it("the vec0 triggers index Float32 rows on insert and update; vectorSearch finds them", async () => {
    const { docs, adapter } = await open();
    await docs.insertOne({ id: "a", title: "t", embedding: [1, 0, 0, 0] });
    await docs.insertOne({ id: "b", title: "t", embedding: [0, 1, 0, 0] });
    expect(storage()).toEqual({ a: "blob", b: "blob" });
    expect(driver.get<{ n: number }>(`SELECT count(*) AS n FROM vs_docs__vec__embedding`)).toEqual({
      n: 2,
    });
    expect(await nearest(adapter, [1, 0, 0, 0])).toEqual(["a", "b"]);
    await docs.updateOne({ id: "b", embedding: [1, 0.1, 0, 0] });
    await docs.updateOne({ id: "a", embedding: [0, 0, 1, 0] });
    expect(await nearest(adapter, [1, 0, 0, 0])).toEqual(["b", "a"]);
  });

  it("a new vec0 index seeds both forms; search orders them together", async () => {
    // The table exists without its vec0 index (an index added later)
    driver = new BetterSqlite3Driver(":memory:", { vector: true });
    const space = new DbSpace(() => new SqliteAdapter(driver));
    const docs = space.getTable(fx.VsDoc) as any;
    await docs.ensureTable();
    writeOld("j_far", [0, 0, 1, 0]);
    writeOld("j_near", [1, 0.2, 0, 0]);
    await docs.insertOne({ id: "f_exact", title: "t", embedding: [1, 0, 0, 0] });
    await docs.insertOne({ id: "f_mid", title: "t", embedding: [1, 1, 0, 0] });
    expect(storage()).toEqual({ j_far: "text", j_near: "text", f_exact: "blob", f_mid: "blob" });

    await docs.syncIndexes();
    expect(driver.get<{ n: number }>(`SELECT count(*) AS n FROM vs_docs__vec__embedding`)).toEqual({
      n: 4,
    });
    expect(await nearest(docs.dbAdapter, [1, 0, 0, 0])).toEqual([
      "f_exact",
      "j_near",
      "f_mid",
      "j_far",
    ]);
    // a JSON-text row written while the index exists (an older version still
    // writing) is indexed by the trigger too
    writeOld("j_late", [1, 0.05, 0, 0]);
    expect((await nearest(docs.dbAdapter, [1, 0, 0, 0])).slice(0, 2)).toEqual([
      "f_exact",
      "j_late",
    ]);
  });

  // The search reads the same column a plain read does: a row of either
  // stored form comes back with its numbers, never the BLOB or the JSON text
  it("vectorSearch and vectorSearchWithCount return the vector as numbers for both stored forms", async () => {
    const { docs } = await open();
    writeOld("json", [1, 0.25, 0, 0]);
    await docs.insertOne({ id: "blob", title: "t", embedding: [1, 0, 0, 0.5] });
    expect(storage()).toEqual({ json: "text", blob: "blob" });
    const expected = [
      { id: "blob", embedding: f32([1, 0, 0, 0.5]) },
      { id: "json", embedding: [1, 0.25, 0, 0] },
    ];

    const rows = await docs.vectorSearch([1, 0, 0, 0]);
    // `toMatchObject` fails a Float32Array, a Buffer or JSON text against the plain arrays
    expect(byId(rows)).toMatchObject(expected);

    const selected = await docs.vectorSearch([1, 0, 0, 0], {
      controls: { $select: ["id", "embedding"] },
    });
    expect(byId(selected)).toMatchObject(expected);

    const counted = await docs.vectorSearchWithCount([1, 0, 0, 0]);
    expect(counted.count).toBe(2);
    expect(byId(counted.data)).toMatchObject(expected);
  });

  it("updating an old JSON-text row rewrites it as Float32; search follows", async () => {
    const { docs, adapter } = await open();
    writeOld("old", [0, 0, 1, 0]);
    await docs.insertOne({ id: "other", title: "t", embedding: [0, 1, 0, 0] });
    await docs.updateOne({ id: "old", embedding: [1, 0, 0, 0] });
    expect(storage()).toEqual({ old: "blob", other: "blob" });
    expect((await docs.findById("old")).embedding).toEqual([1, 0, 0, 0]);
    expect(await nearest(adapter, [1, 0, 0, 0])).toEqual(["old", "other"]);
  });

  // An array patch operator is a read-modify-write: the stored BLOB is decoded
  // through fromStorage (the core reads it raw — before 0.1.178 a BLOB's bytes
  // were taken for the array), the result is written as JSON text.
  it("array patch operators apply to the decoded vector — renamed column too", async () => {
    const { space, docs, adapter } = await open({ sync: [fx.VsDoc, fx.VsRenamed] });
    const renamed = space.getTable(fx.VsRenamed) as any;
    await docs.insertOne({ id: "a", title: "t", embedding: [0.5, 0.25, 0, 0] });
    await renamed.insertOne({ id: "r", embedding: [0.5, 0.25, 0, 0] });
    expect(storage()).toEqual({ a: "blob" });
    expect(storage("vs_renamed", "emb_col")).toEqual({ r: "blob" });

    const patch = { $remove: [0.25], $insert: [0.75] };
    await docs.updateOne({ id: "a", embedding: patch });
    await renamed.updateOne({ id: "r", embedding: patch });
    expect((await docs.findById("a")).embedding).toEqual([0.5, 0, 0, 0.75]);
    expect((await renamed.findById("r")).embedding).toEqual([0.5, 0, 0, 0.75]);
    expect(storage()).toEqual({ a: "text" });
    expect(storage("vs_renamed", "emb_col")).toEqual({ r: "text" });
    // the vec0 row follows the rewritten value
    expect(await nearest(adapter, [0.5, 0, 0, 0.75])).toEqual(["a"]);
  });

  it("a view reading the vector decodes both forms (the annotation is not passed to it)", async () => {
    const { space, docs } = await open({ sync: [fx.VsDoc, fx.VsDocView] });
    writeOld("old", [1, 0.5, 0, 0]);
    await docs.insertOne({ id: "new", title: "t", embedding: v });
    const view = space.getView(fx.VsDocView) as any;
    expect(await view.findMany({ filter: {}, controls: { $sort: { id: 1 } } })).toEqual([
      { id: "new", title: "t", embedding: f32(v) },
      { id: "old", title: "old", embedding: [1, 0.5, 0, 0] },
    ]);
  });

  it("with the annotation removed from the model, Float32 rows still read as numbers", async () => {
    const { docs } = await open();
    await docs.insertOne({ id: "new", title: "t", embedding: v });
    writeOld("old", [1, 0, 0, 0]);
    const plain = new DbSpace(() => new SqliteAdapter(driver)).getTable(fx.VsDocPlain) as any;
    expect((await plain.findById("new")).embedding).toEqual(f32(v));
    expect((await plain.findById("old")).embedding).toEqual([1, 0, 0, 0]);
  });

  it("recreateTable copies both forms byte for byte; the re-seeded index finds them", async () => {
    const { docs, adapter } = await open();
    writeOld("old", [0, 1, 0, 0]);
    await docs.insertOne({ id: "new", title: "t", embedding: [1, 0, 0, 0] });
    const bytes = () =>
      driver.all(`SELECT id, typeof(embedding) AS t, hex(embedding) AS h FROM vs_docs ORDER BY id`);
    const before = bytes();

    await adapter.recreateTable();
    expect(bytes()).toEqual(before);
    expect((await docs.findById("old")).embedding).toEqual([0, 1, 0, 0]);
    expect((await docs.findById("new")).embedding).toEqual([1, 0, 0, 0]);
    await docs.syncIndexes(); // recreate drops the vec0 index; the sync re-seeds it
    expect(await nearest(adapter, [0, 1, 0, 0])).toEqual(["old", "new"]);
  });

  it("a vector inside a flattened nested object round-trips as Float32 and is searchable", async () => {
    const { space } = await open({ sync: [fx.VsNested] });
    const nested = space.getTable(fx.VsNested) as any;
    await nested.insertOne({ id: "a", info: { label: "x", embedding: v } });
    await nested.insertOne({ id: "b", info: { label: "y", embedding: [0, 0, 0, 1] } });
    expect(storage("vs_nested", "info__embedding")).toEqual({ a: "blob", b: "blob" });
    expect(await nested.findById("a")).toEqual({
      id: "a",
      info: { label: "x", embedding: f32(v) },
    });
    expect(await nearest(nested.dbAdapter, [0, 0, 0, 1])).toEqual(["b", "a"]);
  });

  it("$groupBy on the vector is refused, as before", async () => {
    const { docs } = await open();
    await expect(
      docs.aggregate({
        filter: {},
        controls: {
          $groupBy: ["embedding"],
          $select: ["embedding", { $fn: "count", $field: "*", $as: "n" }],
        },
      }),
    ).rejects.toThrow('Cannot group by "embedding"');
  });
});

/** `values` as float32 bytes (host order) starting at `offset` of a larger buffer. */
function blobAt(offset: number, values: number[]): Buffer {
  const pool = Buffer.alloc(offset + values.length * 4 + 3);
  pool.set(new Uint8Array(new Float32Array(values).buffer), offset);
  return pool.subarray(offset, offset + values.length * 4);
}

describe("[sqlite] vector formatter", () => {
  /** The vector column's formatters of a table on a driver with / without sqlite-vec. */
  function formatters(hasVectorExt: boolean) {
    const fake = new RecordingDriver(new BetterSqlite3Driver(":memory:"));
    Object.assign(fake, { hasVectorExt });
    driver = fake as unknown as BetterSqlite3Driver;
    const meta = (
      new DbSpace(() => new SqliteAdapter(fake)).getTable(fx.VsDoc) as any
    ).getMetadata();
    return {
      toStorage: meta.toStorageFormatters.get("embedding") as (v: unknown) => unknown,
      fromStorage: meta.fromStorageFormatters.get("embedding") as (v: unknown) => unknown,
    };
  }

  it("decodes a BLOB at any byte offset (a Float32Array view needs 4-byte alignment)", () => {
    const { fromStorage } = formatters(true);
    for (const offset of [0, 1, 2, 3, 5]) {
      const blob = blobAt(offset, [0.5, -2, 3.25]);
      expect(blob.byteOffset).toBe(offset);
      expect(fromStorage(blob), `offset ${offset}`).toEqual([0.5, -2, 3.25]);
      // a plain Uint8Array (node:sqlite) decodes alike
      expect(fromStorage(new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength))).toEqual([
        0.5, -2, 3.25,
      ]);
    }
    expect(() => new Float32Array(blobAt(1, [1]).buffer, 1, 1)).toThrow(RangeError);
  });

  it("a BLOB whose length is not a multiple of 4 is returned as is", () => {
    const { fromStorage } = formatters(true);
    const odd = Buffer.from([1, 2, 3, 4, 5]);
    expect(fromStorage(odd)).toBe(odd);
    expect(fromStorage(Buffer.alloc(0))).toEqual([]);
  });

  it("with sqlite-vec: JSON text of numbers becomes a Float32 BLOB (host order, as sqlite-vec reads it), anything else stays", () => {
    const { toStorage } = formatters(true);
    const blob = toStorage("[1.5,-2]") as Buffer;
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(blob).toEqual(Buffer.from(new Float32Array([1.5, -2]).buffer));
    for (const kept of ["not json", '["a",1]', "{}", '"1"', "[1,null]"]) {
      expect(toStorage(kept), kept).toBe(kept);
    }
    expect(toStorage(null)).toBe(null);
    expect(toStorage(true)).toBe(true); // an `$exists` operand
  });

  it("without sqlite-vec: JSON text stays JSON text", () => {
    const { toStorage } = formatters(false);
    expect(toStorage("[1.5,-2]")).toBe("[1.5,-2]");
    expect(toStorage([1.5, -2])).toBe("[1.5,-2]");
  });
});

describe("[sqlite] a busy vector probe during a write", () => {
  it.skipIf(!sqliteVecAvailable)(
    "fails with LOCK_TIMEOUT and stores nothing; the next write stores a Float32 BLOB",
    async () => {
      // RecordingDriver has no `hasVectorExt`: the adapter probes on first use
      const inner = new BetterSqlite3Driver(":memory:", { vector: true });
      driver = inner;
      await new DbSpace(() => new SqliteAdapter(inner)).getTable(fx.VsDoc).ensureTable();

      // answers the first `vec_version()` probe with SQLITE_BUSY
      const busy = new RecordingDriver(inner);
      const get = busy.get.bind(busy);
      let failures = 1;
      busy.get = ((sql: string, params?: unknown[]) => {
        if (sql === "SELECT vec_version()" && failures-- > 0) {
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
        return get(sql, params);
      }) as typeof busy.get;
      const docs = new DbSpace(() => new SqliteAdapter(busy)).getTable(fx.VsDoc) as any;
      expectLockTimeout(
        await caught(docs.insertOne({ id: "a", title: "t", embedding: [1, 0, 0, 0] })),
        { code: "SQLITE_BUSY" },
      );
      expect(storage()).toEqual({});
      await docs.insertOne({ id: "a", title: "t", embedding: [1, 0, 0, 0] });
      expect(storage()).toEqual({ a: "blob" });
    },
  );
});

// sqlite-vec loaded on one run and not on the next (or the reverse): the
// column type `typeMapper` gives flips between BLOB and TEXT, which schema
// sync refuses as a type change (as before 0.1.178). The rows read back either way.
vecDescribe("[sqlite] a database opened with and without sqlite-vec", () => {
  const file = () => {
    dir = mkdtempSync(join(tmpdir(), "asdb-vector-"));
    return join(dir, "db.sqlite");
  };

  it("written with sqlite-vec, opened without: both forms read back; sync refuses the type change", async () => {
    const path = file();
    const first = await open({ file: path });
    await first.docs.insertOne({ id: "new", title: "t", embedding: [0.1, 0.2, 0.3, 0.4] });
    writeOld("old", [1, 0.5, 0, 0]);
    expect(storage()).toEqual({ new: "blob", old: "text" });
    driver.close();

    const { docs, result } = await open({ file: path, vector: false });
    expect(result.entries.find((e) => e.name === "vs_docs")?.errors).toEqual([
      'Type change on vs_docs.embedding (BLOB → json). Add @db.sync.method "recreate" or "drop", or migrate manually.',
    ]);
    expect((await docs.findById("new")).embedding).toEqual(f32([0.1, 0.2, 0.3, 0.4]));
    expect((await docs.findById("old")).embedding).toEqual([1, 0.5, 0, 0]);
  });

  it("written without sqlite-vec, opened with: JSON-text rows read back, new writes are Float32; sync refuses the type change", async () => {
    const path = file();
    const first = await open({ file: path, vector: false });
    await first.docs.insertOne({ id: "old", title: "t", embedding: [1, 0.5, 0, 0] });
    expect(storage()).toEqual({ old: "text" });
    driver.close();

    const { docs, result } = await open({ file: path });
    expect(result.entries.find((e) => e.name === "vs_docs")?.errors).toEqual([
      'Type change on vs_docs.embedding (TEXT → json). Add @db.sync.method "recreate" or "drop", or migrate manually.',
    ]);
    await docs.insertOne({ id: "new", title: "t", embedding: [0.1, 0.2, 0.3, 0.4] });
    expect(storage()).toEqual({ old: "text", new: "blob" });
    expect((await docs.findById("old")).embedding).toEqual([1, 0.5, 0, 0]);
    expect((await docs.findById("new")).embedding).toEqual(f32([0.1, 0.2, 0.3, 0.4]));
  });
});
