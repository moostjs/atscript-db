import { describe, it, expect } from "vite-plus/test";
import { HttpError } from "@moostjs/event-http";

import { resolvePkSource } from "../actions/pk-source";

/**
 * `@DbActionPK*` are smart resolvers that validate the request body against
 * a typed table's PK schema. If the host controller has no typed table
 * attached, the resolver has nothing to validate against — that's a server
 * misconfiguration (not a client error) and surfaces as HTTP 500.
 */

describe("resolvePkSource — server-misconfiguration handling", () => {
  it("returns the readable when present", () => {
    const ctrl = {
      readable: {
        primaryKeys: ["id"],
        fieldDescriptors: [{ path: "id", designType: "string" }],
      },
    };
    const src = resolvePkSource(ctrl);
    expect(src.primaryKeys).toEqual(["id"]);
  });

  it("returns the table when only table (no readable) is exposed", () => {
    const ctrl = {
      table: {
        primaryKeys: ["id"],
        fieldDescriptors: [{ path: "id", designType: "string" }],
      },
    };
    const src = resolvePkSource(ctrl);
    expect(src.primaryKeys).toEqual(["id"]);
  });

  it("throws HTTP 500 when the controller exposes neither readable nor table", () => {
    expect(() => resolvePkSource({})).toThrow(HttpError);
    try {
      resolvePkSource({});
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      const err = e as HttpError;
      expect(err.body.statusCode).toBe(500);
      expect(err.body.message).toContain("@DbActionPK");
      expect(err.body.message).toContain("@TableController");
    }
  });

  it("throws HTTP 500 when readable is present but missing primaryKeys/fieldDescriptors", () => {
    const ctrl = { readable: { tableName: "something" } };
    expect(() => resolvePkSource(ctrl)).toThrow(HttpError);
  });
});
