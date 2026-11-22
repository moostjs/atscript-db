/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { BetterSqlite3Driver, createAdapter as createSqlite } from "@atscript/db-sqlite";
import type { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import { Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { bootHttp, prepareFixtures, type THttpSend } from "./test-utils";

// Since 0.1.183 every row of a `$vector` read carries `$score` (higher =
// closer, the `$threshold` scale) in the JSON response — under `$select` too,
// on `/query` and `/pages` — like `$distance` on `/geo`. It is not a field: a
// client cannot name it in `$select`. Since 0.1.184 the rows no longer carry
// the engine's `_distance`.

let sqliteVecAvailable = true;
try {
  new BetterSqlite3Driver(":memory:", { vector: true }).close();
} catch {
  sqliteVecAvailable = false;
}

let space: DbSpace;
let send: THttpSend;

type Row = { id?: number; title?: string; $score: number };

const VECTOR = "$search=q&$vector=embedding";

describe.skipIf(!sqliteVecAvailable)("[sqlite] $score over HTTP", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const { VrDoc } = await import("./fixtures/vector-read.as");
    getMoostInfact()._cleanup();
    space = createSqlite(":memory:", { vector: true });
    const result = await new SchemaSync(space).run([VrDoc], { force: true });
    expect(result.status).toBe("synced");
    const table = space.getTable(VrDoc) as any;
    // cosine 1, 0, −1 to the query [1, 0, 0]: score 1, 0.5, 0
    await table.insertMany([
      { id: 1, title: "same", embedding: [1, 0, 0] },
      { id: 2, title: "orthogonal", embedding: [0, 1, 0] },
      { id: 3, title: "opposite", embedding: [-1, 0, 0] },
    ]);

    @TableController(table, "vs")
    @Inherit()
    class Docs extends AsDbController {
      protected override async computeEmbedding(): Promise<number[]> {
        return [1, 0, 0];
      }
    }
    send = await bootHttp(Docs);
  });

  afterAll(async () => {
    await space?.close();
  });

  it("/query rows carry $score, closest first", async () => {
    const res = await send("GET", `/vs/query?${VECTOR}`);
    expect(res.status).toBe(200);
    const rows = res.body as Row[];
    expect(rows.map((r) => [r.id, r.$score])).toEqual([
      [1, 1],
      [2, 0.5],
      [3, 0],
    ]);
    for (const row of rows) expect(row).not.toHaveProperty("_distance");
  });

  it("$select keeps $score; $threshold returns only rows that reach it", async () => {
    const selected = await send("GET", `/vs/query?${VECTOR}&$select=title`);
    expect(selected.body[0]).toEqual({ id: 1, title: "same", $score: 1 });

    const capped = await send("GET", `/vs/query?${VECTOR}&$threshold=0.4`);
    expect((capped.body as Row[]).map((r) => r.id)).toEqual([1, 2]);
  });

  it("/pages rows carry $score and the count agrees with them", async () => {
    const res = await send("GET", `/vs/pages?${VECTOR}&$threshold=0.4&$size=1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 2, pages: 2 });
    expect(res.body.data).toEqual([{ id: 1, title: "same", embedding: [1, 0, 0], $score: 1 }]);
  });

  it("$score is not a field: $select cannot name it and /meta does not list it", async () => {
    const res = await send("GET", `/vs/query?${VECTOR}&$select=title,$score`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("$score");
    const meta = await send("GET", "/vs/meta");
    expect(Object.keys(meta.body.fields)).not.toContain("$score");
  });

  it("a $threshold that is not a number answers 400", async () => {
    for (const path of ["query", "pages"]) {
      const res = await send("GET", `/vs/${path}?${VECTOR}&$threshold=abc`);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("$threshold");
    }
  });
});
