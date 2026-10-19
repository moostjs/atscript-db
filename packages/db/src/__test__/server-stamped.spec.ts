import { describe, it, expect } from "vite-plus/test";

import { DERIVED_INCOMPATIBLE } from "../shared/derived-rules";
import { SERVER_STAMPED_ON_UPDATE_KEYS, isServerStampedOnUpdate } from "../validator";

describe("isServerStampedOnUpdate", () => {
  it("lists exactly the two onUpdate annotations", () => {
    expect([...SERVER_STAMPED_ON_UPDATE_KEYS]).toEqual(["db.onUpdate.now", "db.onUpdate.inc"]);
  });

  it.each([
    [["db.onUpdate.now"], true],
    [["db.onUpdate.inc"], true],
    [["db.onUpdate.now", "db.onUpdate.inc"], true],
    [["db.default.now"], false],
    [["db.column.version"], false],
    [[], false],
  ])("%j → %j", (keys, expected) => {
    const metadata = new Map(keys.map((k) => [k, true]));
    expect(isServerStampedOnUpdate(metadata)).toBe(expected);
  });

  it("keeps the derived-column rules for both keys", () => {
    const rows = DERIVED_INCOMPATIBLE.filter(([name]) => name.startsWith("db.onUpdate."));
    expect(rows).toEqual([
      ["db.onUpdate.now", "a derived column is never written"],
      ["db.onUpdate.inc", "a derived column is never written"],
    ]);
  });
});
