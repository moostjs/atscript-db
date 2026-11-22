import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { mergeStrategyPaths } from "@atscript/db/validator";
import { deserializeAnnotatedType } from "@atscript/typescript/utils";

import { AsDbController } from "../as-db.controller";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, prepareFixtures } from "./test-utils";

/**
 * A client decides where a patch may send a partial object from the `/meta`
 * type with the server's rule (`mergeStrategyPaths`, since 0.1.184). The rule
 * reads `@db.json` and `@db.encrypted`, so `/meta` keeps both: before, it
 * stripped `@db.encrypted`, and db-client's preflight accepted a partial
 * object inside an encrypted field that the server rejects.
 */

let MpmItem: any;

const sorted = (paths: ReadonlySet<string>) => [...paths].toSorted();

beforeAll(async () => {
  await prepareFixtures();
  ({ MpmItem } = await import("./fixtures/merge-paths-meta.as"));
});

describe("/meta — where the merge strategy applies", () => {
  it("the served type gives the server's merge paths", async () => {
    const table = new DbSpace(() => new MockAdapter(), {
      encryption: { defaultKeyId: "k1", keys: { k1: randomBytes(32) } },
    }).getTable(MpmItem);
    const meta = await new AsDbController(makeApp(), table as any).meta();
    const served = deserializeAnnotatedType(JSON.parse(JSON.stringify(meta.type)));

    expect(sorted(mergeStrategyPaths(served))).toEqual(["maybe.geo", "prefs", "prefs.geo"]);
    expect(sorted(mergeStrategyPaths(served))).toEqual(sorted(mergeStrategyPaths(MpmItem)));
    expect((meta.type as any).type.props.eprefs.metadata["db.encrypted"]).toBe(true);
  });
});
