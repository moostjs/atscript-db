/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { BetterSqlite3Driver, createAdapter as createSqlite } from "@atscript/db-sqlite";
import type { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import { Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { bootHttp, prepareFixtures, type THttpSend } from "./test-utils";

// SQLite stores a vector as a Float32 BLOB with sqlite-vec (since 0.1.178);
// rows from before hold JSON text. The table layer's read decodes both
// (the adapter's `fromStorage`), so an HTTP read answers a JSON array of
// numbers for either — never a serialized Buffer.

let sqliteVecAvailable = true;
try {
  new BetterSqlite3Driver(":memory:", { vector: true }).close();
} catch {
  sqliteVecAvailable = false;
}

let space: DbSpace;
let send: THttpSend;

describe.skipIf(!sqliteVecAvailable)("[sqlite] a vector read over HTTP", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const { VrDoc } = await import("./fixtures/vector-read.as");
    getMoostInfact()._cleanup();
    space = createSqlite(":memory:", { vector: true });
    const result = await new SchemaSync(space).run([VrDoc], { force: true });
    expect(result.status).toBe("synced");
    const table = space.getTable(VrDoc) as any;
    await table.insertOne({ id: 1, title: "new", embedding: [0.1, 0.5, 1] });
    // a row as a version before 0.1.178 wrote it
    const driver = table.dbAdapter.driver as BetterSqlite3Driver;
    driver.run(`INSERT INTO vr_docs (id, title, embedding) VALUES (2, 'old', '[1,0,0.5]')`);
    expect(driver.all(`SELECT typeof(embedding) AS t FROM vr_docs ORDER BY id`)).toEqual([
      { t: "blob" },
      { t: "text" },
    ]);

    @TableController(table, "vr")
    @Inherit()
    class Docs extends AsDbController {}
    send = await bootHttp(Docs);
  });

  afterAll(async () => {
    await space?.close();
  });

  it("/one/:id answers the vector as a JSON array of numbers, Float32 and JSON-text rows alike", async () => {
    const fresh = await send("GET", "/vr/one/1");
    expect(fresh.status).toBe(200);
    expect(fresh.body.embedding).toEqual(Array.from(new Float32Array([0.1, 0.5, 1])));
    const old = await send("GET", "/vr/one/2");
    expect(old.body.embedding).toEqual([1, 0, 0.5]);
  });

  it("/query and $select=embedding answer arrays too", async () => {
    const res = await send("GET", "/vr/query?$select=id,embedding&$sort=id");
    expect(res.body).toEqual([
      { id: 1, embedding: Array.from(new Float32Array([0.1, 0.5, 1])) },
      { id: 2, embedding: [1, 0, 0.5] },
    ]);
  });
});
