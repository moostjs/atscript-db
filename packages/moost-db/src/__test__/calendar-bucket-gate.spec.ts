import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbError, DbSpace } from "@atscript/db";
import type { BucketUnit, TDbFieldMeta } from "@atscript/db";
import { BUCKET_UNITS } from "@uniqu/core";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import { validationErrorTransform } from "../validation-interceptor";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { createMockApp as makeApp, errorsOf, prepareFixtures } from "./test-utils";

/**
 * Calendar buckets over HTTP (since 0.1.132): the gate runs the core's shared
 * normalizer first (before the controls DTO), then checks each bucket source
 * against the capability index (op `bucket`); `/meta.fields[P].bucketable`
 * and `/meta.bucketUnits` are projections of the same index.
 */

const KEYS = { k1: randomBytes(32) };

class BucketAdapter extends MockAdapter {
  units: ReadonlySet<BucketUnit> = new Set(BUCKET_UNITS);
  geo = false;
  override calendarBucketUnits(): ReadonlySet<BucketUnit> {
    return this.units;
  }
  override isGeoSearchable(): boolean {
    return this.geo;
  }
}

class NestedBucketAdapter extends BucketAdapter {
  override supportsNestedObjects(): boolean {
    return true;
  }
  override canFilterField(fd: TDbFieldMeta): boolean {
    return !fd.encrypted;
  }
}

let BucketTicket: any;
let BucketLoose: any;

function bind(type: any, make: () => BucketAdapter = () => new BucketAdapter()) {
  const adapters: BucketAdapter[] = [];
  const db = new DbSpace(
    () => {
      const a = make();
      adapters.push(a);
      return a;
    },
    { encryption: { defaultKeyId: "k1", keys: KEYS } },
  );
  const table = db.getTable(type);
  const controller = new AsDbController(makeApp(), table as any);
  return { table, controller, adapter: adapters[adapters.length - 1]! };
}

const bucketUrl = (field: string, unit = "day") =>
  `?$select=bucket(${field},${unit}):d,count(*):n&$groupBy=d`;

async function rejected(result: Promise<unknown>): Promise<HttpError> {
  const res = await result;
  expect(res).toBeInstanceOf(HttpError);
  return res as HttpError;
}

beforeAll(async () => {
  await prepareFixtures();
  ({ BucketTicket, BucketLoose } = await import("./fixtures/bucket-tickets.as"));
});

describe("/meta ⇔ gate parity for calendar buckets", () => {
  it.each([
    ["strict, relational", () => bind(BucketTicket)],
    ["loose, relational", () => bind(BucketLoose)],
    ["loose, nested-object", () => bind(BucketLoose, () => new NestedBucketAdapter())],
  ])("%s: bucketable ⇔ a bucket over the field is accepted", async (_name, make) => {
    const { controller, adapter } = make();
    const meta = await controller.meta();
    expect(meta.bucketUnits).toEqual(["day", "week", "month", "quarter", "year"]);
    for (const [path, f] of Object.entries(meta.fields)) {
      const res = await controller.query(bucketUrl(path));
      const accepted = !(res instanceof HttpError);
      expect(accepted, `bucket parity for "${path}"`).toBe(f.bucketable === true);
      // Non-bucketable fields carry no key at all (absent, not false).
      if (!accepted) expect("bucketable" in f, path).toBe(false);
    }
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(true);
  });

  it("strict table: exactly the timestamp dimensions are bucketable", async () => {
    const { controller } = bind(BucketTicket);
    const meta = await controller.meta();
    const bucketable = Object.keys(meta.fields).filter((p) => meta.fields[p]!.bucketable);
    expect(bucketable).toEqual(["openedAt", "closedAt"]);
  });

  it("loose table: flattened / nested timestamps are bucketable, JSON-nested and encrypted are not", async () => {
    for (const make of [() => new BucketAdapter(), () => new NestedBucketAdapter()]) {
      const { controller } = bind(BucketLoose, make);
      const meta = await controller.meta();
      const bucketable = Object.keys(meta.fields).filter((p) => meta.fields[p]!.bucketable);
      expect(bucketable).toEqual(["openedAt", "stats.firstSeenAt"]);
    }
  });

  it("an adapter without calendar buckets advertises nothing and the gate says why", async () => {
    const { controller } = bind(BucketTicket, () => {
      const a = new BucketAdapter();
      a.units = new Set();
      return a;
    });
    const meta = await controller.meta();
    expect("bucketUnits" in meta).toBe(false);
    expect(Object.values(meta.fields).some((f) => "bucketable" in f)).toBe(false);
    const res = await rejected(controller.query(bucketUrl("openedAt")));
    expect(errorsOf(res)).toEqual([
      {
        path: "openedAt",
        message: 'Bucketing field "openedAt" is not permitted — adapter has no calendar buckets.',
      },
    ]);
  });
});

describe("gate wording", () => {
  it("schema rules answer with the FIELD as path, before the core", async () => {
    const { controller, adapter } = bind(BucketTicket);
    const cases: Array<[string, string]> = [
      [
        "points",
        'Bucketing field "points" is not permitted — not a timestamp field (declare it number.timestamp).',
      ],
      ["reviewedAt", 'Bucketing field "reviewedAt" is not permitted — not a dimension.'],
      ["createdAt", 'Bucketing field "createdAt" is not permitted — not a dimension.'],
      ["nope", 'Unknown field "nope"'],
    ];
    for (const [field, message] of cases) {
      const res = await rejected(controller.query(bucketUrl(field)));
      expect(res.body.statusCode, field).toBe(400);
      expect(errorsOf(res), field).toEqual([{ path: field, message }]);
    }
    expect(adapter.calls.some((c) => c.method === "aggregate")).toBe(false);
  });

  it("a @db.writeOnly source keeps the aggregate seal's message", async () => {
    const { controller } = bind(BucketTicket);
    const res = await rejected(controller.query(bucketUrl("secretAt")));
    expect(res.body.message).toBe('Field "secretAt" is @db.writeOnly and cannot be aggregated');
  });

  it("metadata-free rules answer with the core normalizer's wording and path", async () => {
    const { controller } = bind(BucketTicket);
    const cases: Array<[string, { path: string; message: string }]> = [
      [
        bucketUrl("openedAt", "fortnight"),
        {
          path: "$select",
          message: 'Unknown bucket unit "fortnight" — use day, week, month, quarter or year',
        },
      ],
      [
        "?$select=bucket(openedAt,day,'Mars/Olympus'):d&$groupBy=d",
        { path: "$select", message: 'Unknown time zone "Mars/Olympus"' },
      ],
      [
        "?$select=bucket(openedAt,day,,sun):d&$groupBy=d",
        { path: "$select", message: '$weekStart is only valid with unit "week", not "day"' },
      ],
      [
        "?$select=status,bucket(openedAt,day):d&$groupBy=status",
        { path: "$select", message: 'Bucket "d" in $select must also appear in $groupBy' },
      ],
      [
        "?$select=bucket(openedAt,day):status&$groupBy=status",
        { path: "$select", message: 'Alias "status" collides with field "status"' },
      ],
      // Before the controls DTO, which would answer with a generic type mismatch.
      [
        "?$select=bucket(openedAt,day):d",
        { path: "$select", message: "Calendar buckets are only valid in grouped queries" },
      ],
    ];
    for (const [url, issue] of cases) {
      const res = await rejected(controller.query(url));
      expect(errorsOf(res), url).toEqual([issue]);
    }
    for (const url of ["?$select=bucket(openedAt,day):d", "?$select=bucket(openedAt,day)"]) {
      const res = await rejected(controller.pages(url));
      expect(errorsOf(res)[0], url).toEqual({
        path: "$select",
        message: "Calendar buckets are only valid in grouped queries",
      });
    }
  });

  it("accepts a valid bucket and hands the core the parsed query (lowercase zone canonicalized by the core)", async () => {
    const { controller, adapter } = bind(BucketTicket);
    adapter.aggregateResult = [{ status: "open", wk: "2026-03-22", n: 2 }];
    const rows = await controller.query(
      "?$select=status,bucket(openedAt,week,'europe/berlin',sun):wk,count(*):n&$groupBy=status,wk&$sort=wk&$having=wk>='2026-03-01'",
    );
    expect(rows).toEqual([{ status: "open", wk: "2026-03-22", n: 2 }]);
    const sent = adapter.calls.find((c) => c.method === "aggregate")!.args[0];
    expect(sent.controls.$select.buckets).toMatchObject([
      { alias: "wk", field: "openedAt", unit: "week", tz: "Europe/Berlin", weekStartIso: 7 },
    ]);
    expect(sent.controls.$groupBy).toEqual(["status", "wk"]);
  });
});

describe("capability index follows the adapter (sync-safe)", () => {
  it("rebuilds when adapter-level capabilities change after the controller was built", async () => {
    const { controller, adapter } = bind(BucketTicket);
    adapter.units = new Set();
    const before = await controller.meta();
    expect(before.bucketUnits).toBeUndefined();
    expect(before.fields.openedAt!.bucketable).toBeUndefined();
    expect(await controller.query(bucketUrl("openedAt"))).toBeInstanceOf(HttpError);

    // e.g. a driver that registers its bucket function late
    adapter.units = new Set(["day", "month"]);
    const after = await controller.meta();
    expect(after.bucketUnits).toEqual(["day", "month"]);
    expect(after.fields.openedAt!.bucketable).toBe(true);
    expect(await controller.query(bucketUrl("openedAt"))).not.toBeInstanceOf(HttpError);
  });

  it("geo support learned after construction (PostgreSQL finds PostGIS during schema sync) reaches /meta and the gate", async () => {
    const { CapRow, CapTarget } = await import("./fixtures/capabilities.as");
    const adapters: BucketAdapter[] = [];
    const db = new DbSpace(
      () => {
        const a = new BucketAdapter();
        adapters.push(a);
        return a;
      },
      { encryption: { defaultKeyId: "k1", keys: KEYS } },
    );
    db.getTable(CapTarget);
    const controller = new AsDbController(makeApp(), db.getTable(CapRow) as any);
    const adapter = adapters[adapters.length - 1]!;
    const geoFilter = { geo: { $geoWithin: { center: [0, 0], radius: 10 } } };
    const gate = () => (controller as any).checkCapabilities({ filter: geoFilter, controls: {} });

    expect((await controller.meta()).fields.geo!.filterOps).toEqual(["$exists"]);
    expect(gate()).toBeInstanceOf(HttpError);

    adapter.geo = true; // schema sync ran after the controller was constructed
    expect((await controller.meta()).fields.geo!.filterOps).toEqual(["$exists", "$geoWithin"]);
    expect(gate()).toBeUndefined();
  });
});

describe("DbError → HTTP status", () => {
  it("BUCKET_TZ_UNAVAILABLE is 501, BUCKET_NOT_SUPPORTED is 400", () => {
    const transform = validationErrorTransform() as unknown as {
      error: (error: unknown, reply: (r: unknown) => void) => void;
    };
    for (const [code, status] of [
      ["BUCKET_TZ_UNAVAILABLE", 501],
      ["BUCKET_NOT_SUPPORTED", 400],
    ] as const) {
      let replied: unknown;
      transform.error(new DbError(code, [{ path: "$select", message: "m" }]), (r) => {
        replied = r;
      });
      expect(replied).toBeInstanceOf(HttpError);
      expect((replied as HttpError).body.statusCode, code).toBe(status);
    }
  });
});
