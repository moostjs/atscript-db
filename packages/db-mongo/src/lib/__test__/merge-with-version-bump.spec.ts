import { DbSpace } from "@atscript/db";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { CollectionPatcher } from "../collection-patcher";
import { MongoAdapter } from "../mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

// Patcher-level pipeline-shape assertions for the as-test bug
// `01-mongo-merge-subdoc-drops-leaf-on-full-rewrite`.
//
// Root cause: aggregation `$set` evaluates `$`-prefixed strings as field-path
// expressions (e.g. `"$scrypt$NEW"` resolves to field `scrypt.NEW`, which is
// missing → the target key is `$$REMOVE`'d). CollectionPatcher wraps any value
// that contains a `$`-prefixed string in `{ $literal: ... }` to disable that
// evaluation. See packages/db-mongo wiki entry on the construction rule.

const mongo: DbSpace = createTestSpace();

function preparePipeline(type: any, payload: any, ops?: { inc?: Record<string, number> }) {
  const table = mongo.getTable(type);
  const adapter = mongo.getAdapter(type) as unknown as MongoAdapter;
  const v = table.getValidator("bulkUpdate")!;
  if (!v.validate(payload, false, { mode: "patch", flatMap: table.flatMap })) {
    throw new Error("invalid payload");
  }
  return new CollectionPatcher(adapter.getPatcherContext(), payload, ops).preparePatch();
}

describe("CollectionPatcher: $-prefixed user values in merge subdoc", () => {
  beforeAll(prepareFixtures);

  const fullLeafPayload = {
    id: 1,
    password: {
      hash: "$scrypt$NEW",
      history: ["$scrypt$OLD"],
      lastChanged: 2000,
      isInitial: false,
    },
  };

  it("wraps $-prefixed scalar string values in {$literal} so Mongo does not evaluate them as field paths", async () => {
    const { PasswordDocFixture } = await import("./fixtures/password-doc.as");
    const { updateFilter } = preparePipeline(PasswordDocFixture, fullLeafPayload);

    expect(updateFilter).toHaveLength(1);
    expect(updateFilter[0]).toEqual({
      $set: {
        id: 1,
        "password.hash": { $literal: "$scrypt$NEW" },
        "password.history": { $literal: ["$scrypt$OLD"] },
        "password.lastChanged": 2000,
        "password.isInitial": false,
      },
    });
  });

  it("leaves non-$-prefixed values unwrapped (only at-risk values get the {$literal} cost)", async () => {
    const { PasswordDocFixture } = await import("./fixtures/password-doc.as");
    const { updateFilter } = preparePipeline(PasswordDocFixture, {
      id: 2,
      password: {
        hash: "plainhash",
        history: ["a", "b"],
        lastChanged: 1234,
        isInitial: true,
      },
    });

    expect(updateFilter[0]).toEqual({
      $set: {
        id: 2,
        "password.hash": "plainhash",
        "password.history": ["a", "b"],
        "password.lastChanged": 1234,
        "password.isInitial": true,
      },
    });
  });

  it("still emits the version auto-bump as a computed expression alongside literals (HTTP-flow shape)", async () => {
    const { PasswordDocFixture } = await import("./fixtures/password-doc.as");
    const { updateFilter } = preparePipeline(PasswordDocFixture, fullLeafPayload, {
      inc: { version: 1 },
    });

    // The bug fingerprint historically suggested mixing literals with the
    // computed `$add` expression in one stage was the culprit. The empirical
    // root cause turned out to be different (`$`-string evaluation, not
    // stage-mixing), so the patcher continues to fold the version bump into
    // the same stage. Captured here so a future regression that drops the
    // version field is caught.
    expect(updateFilter).toHaveLength(1);
    const stage = updateFilter[0] as { $set: Record<string, unknown> };
    expect(stage.$set.version).toEqual({ $add: ["$version", 1] });
    expect(stage.$set["password.hash"]).toEqual({ $literal: "$scrypt$NEW" });
  });
});
