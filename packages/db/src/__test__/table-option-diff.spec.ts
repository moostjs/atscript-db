import { describe, it, expect } from "vite-plus/test";
import { computeTableOptionDiff } from "../schema/table-option-diff";
import type { TExistingTableOption } from "../types";

function opt(key: string, value: string): TExistingTableOption {
  return { key, value };
}

describe("computeTableOptionDiff", () => {
  it("should detect changed options", () => {
    const desired = [opt("engine", "MyISAM"), opt("charset", "utf8mb4")];
    const existing = [opt("engine", "InnoDB"), opt("charset", "utf8mb4")];
    const diff = computeTableOptionDiff(desired, existing);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toEqual({
      key: "engine",
      oldValue: "InnoDB",
      newValue: "MyISAM",
      destructive: false,
    });
  });

  it("should return empty diff when options match", () => {
    const desired = [opt("engine", "InnoDB"), opt("charset", "utf8mb4")];
    const existing = [opt("engine", "InnoDB"), opt("charset", "utf8mb4")];
    const diff = computeTableOptionDiff(desired, existing);
    expect(diff.changed).toHaveLength(0);
  });

  it("should ignore options present only in desired (initial state)", () => {
    const desired = [opt("engine", "InnoDB"), opt("charset", "utf8mb4")];
    const existing = [opt("engine", "InnoDB")];
    const diff = computeTableOptionDiff(desired, existing);
    expect(diff.changed).toHaveLength(0);
  });

  it("should ignore options present only in existing (sticky)", () => {
    const desired = [opt("engine", "InnoDB")];
    const existing = [opt("engine", "InnoDB"), opt("charset", "utf8mb4")];
    const diff = computeTableOptionDiff(desired, existing);
    expect(diff.changed).toHaveLength(0);
  });

  it("should mark destructive keys from provided set", () => {
    const desired = [opt("capped.size", "2000")];
    const existing = [opt("capped.size", "1000")];
    const destructiveKeys = new Set(["capped.size", "capped.max"]);
    const diff = computeTableOptionDiff(desired, existing, destructiveKeys);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].destructive).toBe(true);
  });

  it("should detect multiple changes", () => {
    const desired = [
      opt("engine", "MyISAM"),
      opt("charset", "latin1"),
      opt("collation", "latin1_swedish_ci"),
    ];
    const existing = [
      opt("engine", "InnoDB"),
      opt("charset", "utf8mb4"),
      opt("collation", "utf8mb4_unicode_ci"),
    ];
    const diff = computeTableOptionDiff(desired, existing);
    expect(diff.changed).toHaveLength(3);
    expect(diff.changed.map((c) => c.key)).toEqual(["engine", "charset", "collation"]);
  });

  it("should return empty diff for empty inputs", () => {
    const diff = computeTableOptionDiff([], []);
    expect(diff.changed).toHaveLength(0);
  });
});
