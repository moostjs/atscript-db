import { describe, expect, it } from "vite-plus/test";
import { MongoServerError } from "mongodb";

import { wrapInvalidQuery } from "../mongo-errors";

describe("wrapInvalidQuery", () => {
  it("wraps MongoServerError code 31249 (Path collision) as DbError INVALID_QUERY so the HTTP layer returns 400 not 500", async () => {
    const original = new MongoServerError({
      message: "Path collision at password",
      code: 31249,
    });
    await expect(
      wrapInvalidQuery(async () => {
        throw original;
      }),
    ).rejects.toMatchObject({
      name: "DbError",
      code: "INVALID_QUERY",
      errors: [{ path: "$select", message: "Path collision at password" }],
    });
  });

  it("wraps MongoServerError code 31254 (mixed inclusion/exclusion) as DbError INVALID_QUERY", async () => {
    const original = new MongoServerError({
      message: "Cannot do exclusion on field x in inclusion projection",
      code: 31254,
    });
    await expect(
      wrapInvalidQuery(async () => {
        throw original;
      }),
    ).rejects.toMatchObject({
      name: "DbError",
      code: "INVALID_QUERY",
      errors: [
        { path: "$select", message: "Cannot do exclusion on field x in inclusion projection" },
      ],
    });
  });

  it("rethrows non-projection MongoServerError unchanged so server-side faults stay 500", async () => {
    const original = new MongoServerError({
      message: "duplicate key",
      code: 11000,
    });
    await expect(
      wrapInvalidQuery(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("rethrows non-Mongo errors unchanged", async () => {
    const original = new Error("network failure");
    await expect(
      wrapInvalidQuery(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("returns the wrapped fn's result unchanged when no error", async () => {
    const result = await wrapInvalidQuery(async () => ({ ok: true, n: 42 }));
    expect(result).toEqual({ ok: true, n: 42 });
  });
});
