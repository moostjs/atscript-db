import { DbError } from "@atscript/db";
import type { DbSpace, TDbFieldMeta } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { createTestSpace, prepareFixtures, user } from "./test-utils";

// Populated after fixtures compile.
let User: any;
let Composite: any;

describe("MemoryAdapter — schema sync + capability overrides", () => {
  beforeAll(async () => {
    await prepareFixtures();
    const fixtures = await import("./fixtures/stored.as");
    User = fixtures.User;
    Composite = fixtures.Composite;
  });

  // ── syncSchema end-to-end ──────────────────────────────────────────────────

  // WHY: proves the full syncSchema path drives through this adapter — the
  // in-memory `__atscript_control` table plus its distributed lock
  // (ensure/insert/find/replace/delete) — and then CRUD on a synced table works.
  it("runs syncSchema end-to-end, then table CRUD works", async () => {
    const db: DbSpace = createTestSpace();

    const result = await syncSchema(db, [User, Composite]);
    expect(result.status).toBe("synced");

    // The table synced above is the SAME cached instance (DbSpace memoizes per
    // type), so its ensureTable()/syncIndexes() already ran — CRUD is live.
    await db.getTable(User).insertOne(user({ id: "u1", name: "Ada", age: 30 }));
    const row = (await db.getTable(User).findOne({ filter: { id: "u1" }, controls: {} })) as any;
    expect(row).toMatchObject({ id: "u1", name: "Ada", age: 30 });
  });

  // WHY: a second sync with an unchanged schema must be a no-op — the control
  // table's stored hash (persisted on the cached control-table adapter) matches,
  // so drift detection short-circuits to "up-to-date" WITHOUT re-running the
  // table/index work or acquiring the lock. This is what makes boot-time sync
  // safe to call on every start.
  it("is idempotent: a second syncSchema sees a matching hash (up-to-date)", async () => {
    const db: DbSpace = createTestSpace();

    const first = await syncSchema(db, [User, Composite]);
    expect(first.status).toBe("synced");

    const second = await syncSchema(db, [User, Composite]);
    expect(second.status).toBe("up-to-date");
    expect(second.schemaHash).toBe(first.schemaHash);

    // CRUD still works against the same cached instance after the no-op re-sync.
    await db.getTable(User).insertOne(user({ id: "u2", name: "Bob", age: 41 }));
    const row = (await db.getTable(User).findOne({ filter: { id: "u2" }, controls: {} })) as any;
    expect(row?.name).toBe("Bob");
  });

  // WHY: the distributed lock's mutual exclusion rests on ONE invariant —
  // inserting a row whose primary key already exists must THROW (that is how
  // `tryAcquireLock` detects a competing pod that won the `insertOne` race on
  // `{ _id: "sync_lock" }`). The control table is an ordinary AtscriptDbTable
  // over this adapter, so its `insertOne` runs the exact same `_insertRow` →
  // duplicate-PK path exercised here on the User table. (The control model
  // itself is not publicly exported, so the invariant is asserted through this
  // already-tested PK-duplicate path, per design.)
  it("enforces the PK-duplicate throw the sync lock relies on", async () => {
    const db: DbSpace = createTestSpace();
    await syncSchema(db, [User, Composite]);

    await db.getTable(User).insertOne(user({ id: "lock", name: "First" }));

    let err: unknown;
    try {
      await db.getTable(User).insertOne(user({ id: "lock", name: "Second", email: "b@x.com" }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).code).toBe("CONFLICT");
  });

  // ── aggregate → typed DbError ──────────────────────────────────────────────

  // WHY: routing a `?$groupBy=` query to aggregate() must NOT surface as the
  // inherited plain-Error 500 — it must be a typed DbError with a 4xx code
  // (INVALID_QUERY → HTTP 400 in moost-db) so REST clients get a clean error.
  it("aggregate() throws a typed DbError (INVALID_QUERY), not the base plain Error", async () => {
    const db: DbSpace = createTestSpace();
    const adapter = db.getAdapter(User);

    const promise = adapter.aggregate({ filter: {}, controls: { $groupBy: ["age"] } as any });
    await expect(promise).rejects.toBeInstanceOf(DbError);
    await expect(promise).rejects.toHaveProperty("code", "INVALID_QUERY");
    // Explicitly NOT the inherited base-adapter plain-Error message.
    await expect(promise).rejects.not.toThrow("Aggregation not supported by this adapter");
  });

  // ── canFilterField parity with Mongo ───────────────────────────────────────

  // WHY: `canFilterField` gates the `filterable` flag exposed to UIs via /meta.
  // The base default vetoes `storage === 'json'` (right for SQL, wrong for an
  // adapter whose dot-path visitor filters json/nested/array values natively).
  // The override mirrors Mongo (`return !fd.encrypted`). This test proves the
  // override via a json-storage descriptor — and contrasts it against
  // canSortField, which is INTENTIONALLY left at the base default, so the SAME
  // descriptor is filterable yet unsortable. The encrypted veto stays absolute.
  //
  // NB: real fixture descriptors never carry storage 'json' on this adapter —
  // supportsNestedObjects() makes the metadata layer skip flattening, storing
  // arrays/nested objects inline as 'column' (asserted on `tags` below). So the
  // override is Mongo-parity/defensive: it only diverges from the base default
  // on a json-storage descriptor, which is why the contract is proved with a
  // synthetic one here.
  it("reports json fields filterable (override) but keeps them unsortable (base default)", () => {
    const db: DbSpace = createTestSpace();
    const adapter = db.getAdapter(User);

    // A json-storage descriptor: base canFilterField would veto it (false), the
    // override reports it filterable; base canSortField (not overridden) vetoes.
    const jsonFd = {
      path: "j",
      physicalName: "j",
      storage: "json",
      encrypted: false,
    } as unknown as TDbFieldMeta;
    expect(adapter.canFilterField(jsonFd)).toBe(true);
    expect(adapter.canSortField(jsonFd)).toBe(false);

    // The @db.encrypted veto is core-supplied and absolute — never filterable.
    const encryptedFd = {
      path: "e",
      physicalName: "e",
      storage: "column",
      encrypted: true,
    } as unknown as TDbFieldMeta;
    expect(adapter.canFilterField(encryptedFd)).toBe(false);
  });

  // WHY: at the real-descriptor level, an array field AND a scalar must both be
  // reported filterable. (On this adapter arrays are stored inline as 'column',
  // not 'json' — supportsNestedObjects skips flattening — so both already clear
  // the base default; this locks that observable behavior in.)
  it("reports the real array field and scalar columns as filterable", () => {
    const db: DbSpace = createTestSpace();
    const users = db.getTable(User);
    const adapter = db.getAdapter(User);

    const descriptors = users.fieldDescriptors;

    const tags = descriptors.find((d: TDbFieldMeta) => d.path === "tags");
    expect(tags).toBeDefined();
    // Documents the actual storage: nested-object adapters keep arrays inline.
    expect(tags!.storage).toBe("column");
    expect(adapter.canFilterField(tags!)).toBe(true);

    const name = descriptors.find((d: TDbFieldMeta) => d.path === "name")!;
    expect(adapter.canFilterField(name)).toBe(true);
  });
});
