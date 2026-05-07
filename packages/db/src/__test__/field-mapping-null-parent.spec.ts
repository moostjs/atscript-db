import { describe, it, expect } from "vite-plus/test";

import { RelationalFieldMapper } from "../strategies/relational-field-mapper";
import type { TableMetadata } from "../table/table-metadata";

// Regression: SECURITY_REPORT.md Finding 2 — `reconstructNullParent` walks a
// dot-path; the loop guard previously rejected only `undefined`, so an
// intermediate literal `null` (common after a flattened parent collapses on a
// prior pass) crashed with `TypeError: Cannot read properties of null`,
// surfacing as HTTP 500 on read-during-update in moost-db.

describe("FieldMappingStrategy.reconstructNullParent — null-deref guard", () => {
  const mapper = new RelationalFieldMapper();
  const fakeMeta = (flat: Record<string, { optional: boolean } | undefined> = {}): TableMetadata =>
    ({
      flatMap: { get: (path: string) => flat[path] },
    }) as unknown as TableMetadata;
  const reconstruct = (obj: Record<string, unknown>, parentPath: string, meta: TableMetadata) =>
    (
      mapper as unknown as {
        reconstructNullParent: (o: Record<string, unknown>, p: string, m: TableMetadata) => void;
      }
    ).reconstructNullParent(obj, parentPath, meta);

  it("does not throw when an intermediate dot-path entry is null", () => {
    const meta = fakeMeta({ "a.b.c": { optional: true } });
    const obj: Record<string, unknown> = { a: { b: null } };

    expect(() => reconstruct(obj, "a.b.c", meta)).not.toThrow();
    expect(obj).toEqual({ a: { b: null } });
  });

  it("still bails out when an intermediate entry is undefined", () => {
    const meta = fakeMeta({ "a.b": { optional: true } });
    const obj: Record<string, unknown> = {};

    expect(() => reconstruct(obj, "a.b", meta)).not.toThrow();
    expect(obj).toEqual({});
  });
});
