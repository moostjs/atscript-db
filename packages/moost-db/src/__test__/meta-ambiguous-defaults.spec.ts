import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { createDbValidatorPlugin, type DbValidationContext } from "@atscript/db/validator";
import {
  deserializeAnnotatedType,
  Validator,
  type TValidatorPlugin,
} from "@atscript/typescript/utils";

import { AsDbController } from "../as-db.controller";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, prepareFixtures } from "./test-utils";

/**
 * `/meta` exposes required-ness through its serialized `type`: `optional` and
 * the annotations — a `@db.default*` field may be omitted on insert. A form
 * (atscript-ui) checks a missing value with `@atscript/db`'s validator plugin,
 * consulting it only for absent values. Since 0.1.155 a default below a tuple
 * or a union of several types is not filled, so such a field stays required
 * there too.
 */

let AmbEvent: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ AmbEvent } = await import("./fixtures/ambiguous-defaults.as"));
});

describe("/meta — defaults below a tuple / union of several types", () => {
  it("a form validating against /meta requires them, other defaults stay optional", async () => {
    const table = new DbSpace(() => new MockAdapter()).getTable(AmbEvent);
    const meta = await new AsDbController(makeApp(), table as any).meta();
    const type = deserializeAnnotatedType(JSON.parse(JSON.stringify(meta.type)));

    // the form's server-managed check: the plugin only for a missing value
    const dbPlugin = createDbValidatorPlugin();
    const insert: DbValidationContext = { mode: "insert" };
    const absentOnly: TValidatorPlugin = (ctx, def, value) =>
      value === undefined
        ? dbPlugin(Object.create(ctx, { context: { value: insert } }), def, value)
        : undefined;
    const validator = new Validator(type, { plugins: [absentOnly] });

    const row = { id: 1, steps: [{ at: 1 }, { note: "n" }], pay: { kind: "bank", iban: "DE" } };
    // `createdAt` omitted: filled by the server
    expect(validator.validate(row, true)).toBe(true);
    expect(validator.validate({ ...row, steps: [{}, { note: "n" }] }, true)).toBe(false);
    expect(validator.errors[0]!.path).toBe("steps.0.at");
    expect(validator.validate({ ...row, pay: { kind: "card" } }, true)).toBe(false);
    expect(validator.errors[0]!.path).toBe("pay");
  });
});
