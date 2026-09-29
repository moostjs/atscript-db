import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { DbSpace } from "../index";
import { computeTableHash, computeTableSnapshot } from "../schema/schema-hash";

import { MockAdapter, NestedMockAdapter, prepareFixtures } from "./test-utils";

// Table hashes of tables WITHOUT a derived column, pinned against the
// values the published @atscript/db@0.1.140 computed for the same fixtures
// (view-source.as, mock typeMapper = designType upper-cased, fixed encryption
// key id). A change here means an existing deployment would re-sync after the
// upgrade — the derived-column snapshot key must stay opt-in.
//
// Baseline computed with the 0.1.140 dist (scratch install), 2026-09-28.
const PINS: Record<string, string> = {
  "sql:VsUser": "3fe6aee8",
  "sql:VsRegion": "73e1f897",
  "sql:VsCountry": "7e8501dc",
  "sql:VsParity": "-4a747fdf",
  "nested:VsUser": "05b90501",
  "nested:VsRegion": "73e1f897",
  "nested:VsCountry": "7e8501dc",
  "nested:VsParity": "41daca85",
};

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/view-source.as");
});

describe("table hashes are unchanged for tables without derived columns (0.1.140 pins)", () => {
  const encryption = { defaultKeyId: "k1", keys: { k1: randomBytes(32) } };

  it.each(Object.entries(PINS))("%s → %s", (key, expected) => {
    const [family, name] = key.split(":") as [string, string];
    const space = new DbSpace(
      () => (family === "sql" ? new MockAdapter() : new NestedMockAdapter()),
      { encryption },
    );
    const readable = space.getTable(fx[name]);
    const hash = computeTableHash(
      computeTableSnapshot(readable, (f) => f.designType.toUpperCase()),
    );
    expect(hash).toBe(expected);
  });
});
