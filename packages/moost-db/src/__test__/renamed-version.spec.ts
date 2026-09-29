import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";
import type { AtscriptDbTable, DbSpace } from "@atscript/db";
import { createAdapter } from "@atscript/db-memory";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import { createMockApp, errorsOf, prepareFixtures } from "./test-utils";

/**
 * OCC over HTTP on a `@db.column`-renamed version field, end to end through a
 * real `DbSpace` + memory adapter. The wire speaks the LOGICAL field name
 * (`/meta.versionColumn`, body `version`, `$cas: { version }`, rows, the 409
 * `currentVersion`); only the adapter touches the physical `row_version`.
 * ≤ 0.1.140 exposed the physical name, so the body `version` was never lifted
 * to `$cas` (no CAS at all) and `$cas: { version }` answered 400.
 */

let RenamedVersionDoc: any;
let RenamedRevisionDoc: any;

beforeAll(async () => {
  await prepareFixtures();
  ({ RenamedVersionDoc, RenamedRevisionDoc } = await import("./fixtures/renamed-version.as"));
});

async function expectHttpError(p: Promise<unknown>, statusCode: number): Promise<HttpError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).body.statusCode).toBe(statusCode);
  return err as HttpError;
}

const bodyOf = (err: HttpError) => err.body as unknown as Record<string, unknown>;

describe("AsDbController — renamed version column (logical `version` → physical `row_version`)", () => {
  let space: DbSpace;
  let table: AtscriptDbTable;
  let controller: AsDbController;

  beforeEach(async () => {
    space = createAdapter();
    table = space.getTable(RenamedVersionDoc);
    await space.getAdapter(RenamedVersionDoc).ensureTable();
    await table.insertMany([
      { id: 1, name: "A", counter: 0 },
      { id: 2, name: "B", counter: 0 },
    ] as never);
    controller = new AsDbController(createMockApp(), table as any);
  });

  const read = async (id = 1) =>
    (await table.findOne({ filter: { id }, controls: {} } as never)) as Record<string, unknown>;
  const stored = async (id = 1) =>
    (await space.getAdapter(RenamedVersionDoc).findOne({ filter: { id }, controls: {} })) as Record<
      string,
      unknown
    >;

  it("GET /meta reports the logical versionColumn", async () => {
    const meta = await controller.meta();
    expect(meta.versionColumn).toBe("version");
    expect(Object.keys(meta.fields)).toContain("version");
    expect(Object.keys(meta.fields)).not.toContain("row_version");
  });

  it("rows read back carry the logical field; storage holds the physical one", async () => {
    const [row] = (await controller.query("?id=1")) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ id: 1, version: 0 });
    expect(row).not.toHaveProperty("row_version");
    expect(await stored()).toMatchObject({ row_version: 0 });
  });

  describe.each(["update", "replace"] as const)("%s — body `version` lifts to `$cas`", (verb) => {
    const send = (body: Record<string, unknown>) =>
      verb === "update" ? controller.update(body) : controller.replace(body);
    const full = (over: Record<string, unknown>) =>
      verb === "update" ? over : { name: "N", counter: 0, ...over };

    it("fresh version applies and bumps by one", async () => {
      expect(await send(full({ id: 1, name: "A2", version: 0 }))).toEqual({
        matchedCount: 1,
        modifiedCount: 1,
      });
      expect(await read()).toMatchObject({ name: "A2", version: 1 });
      expect(await stored()).toMatchObject({ row_version: 1 });
    });

    it("stale version → 409 with the current (logical) version; row untouched", async () => {
      await send(full({ id: 1, name: "A2", version: 0 }));
      const err = await expectHttpError(send(full({ id: 1, name: "A3", version: 0 })), 409);
      expect(bodyOf(err)).toMatchObject({ kind: "version_mismatch", currentVersion: 1 });
      expect(await read()).toMatchObject({ name: "A2", version: 1 });
    });

    it("missing row → 404", async () => {
      await expectHttpError(send(full({ id: 404, name: "X", version: 0 })), 404);
    });

    it("raw `$cas: { version }` is accepted as sent", async () => {
      await send(full({ id: 1, name: "A2", $cas: { version: 0 } }));
      const err = await expectHttpError(
        send(full({ id: 1, name: "A3", $cas: { version: 0 } })),
        409,
      );
      expect(bodyOf(err).currentVersion).toBe(1);
    });

    it("`$cas` keyed by the physical column → 400", async () => {
      const err = await expectHttpError(send(full({ id: 1, $cas: { row_version: 0 } })), 400);
      expect(errorsOf(err)[0]!.path).toBe("$cas.row_version");
      expect(await read()).toMatchObject({ version: 0 });
    });

    it("`version` + differing `$cas` → 400 at `$cas`", async () => {
      const err = await expectHttpError(
        send(full({ id: 1, version: 0, $cas: { version: 3 } })),
        400,
      );
      expect(errorsOf(err)).toEqual([
        { path: "$cas", message: 'Ambiguous version: "version" and "$cas.version" differ' },
      ]);
    });
  });

  it("PATCH PK-only `{ id, version }` is a versioned touch", async () => {
    expect(await controller.update({ id: 1, version: 0 })).toEqual({
      matchedCount: 1,
      modifiedCount: 1,
    });
    expect(await read()).toMatchObject({ name: "A", version: 1 });
    await expectHttpError(controller.update({ id: 1, version: 0 }), 409);
  });

  it("bulk PATCH with mixed fresh/stale versions applies only the fresh rows", async () => {
    await controller.update({ id: 2, name: "B1", version: 0 });
    const result = await controller.update([
      { id: 1, name: "A2", version: 0 },
      { id: 2, name: "B2", version: 0 },
    ]);
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    expect(await read(1)).toMatchObject({ name: "A2", version: 1 });
    expect(await read(2)).toMatchObject({ name: "B1", version: 1 });
  });

  it("bulk PUT with mixed fresh/stale versions applies only the fresh rows", async () => {
    const result = await controller.replace([
      { id: 1, name: "A2", counter: 1, version: 0 },
      { id: 2, name: "B2", counter: 1, version: 7 },
    ]);
    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    expect(await read(1)).toMatchObject({ name: "A2", version: 1 });
    expect(await read(2)).toMatchObject({ name: "B", version: 0 });
  });
});

describe("AsDbController — logical version field not named `version`", () => {
  // WHY: the lift keys on `/meta.versionColumn`, whatever the field is called —
  // here logical `revision` stored as `rev`.
  it("lifts a body `revision` to `$cas` and reports it in /meta and the 409", async () => {
    const space = createAdapter();
    const table = space.getTable(RenamedRevisionDoc);
    await space.getAdapter(RenamedRevisionDoc).ensureTable();
    await table.insertOne({ id: 1, name: "A" } as never);
    const controller = new AsDbController(createMockApp(), table as any);

    expect((await controller.meta()).versionColumn).toBe("revision");
    expect(await controller.update({ id: 1, name: "A2", revision: 0 })).toEqual({
      matchedCount: 1,
      modifiedCount: 1,
    });
    const err = await expectHttpError(controller.update({ id: 1, name: "A3", revision: 0 }), 409);
    expect(bodyOf(err).currentVersion).toBe(1);
  });
});
