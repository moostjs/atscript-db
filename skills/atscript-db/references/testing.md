# testing

Patterns for testing **an application that consumes atscript-db** — not for testing atscript-db itself.

## Test DB choices

| Stack      | Engine                           | Use when                                                                                                                                                                                                  |
| ---------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite     | `better-sqlite3` with `:memory:` | Default for unit + integration. Synchronous, zero setup, adapter-parity holds. Add `sqlite-vec` + `{ vector: true }` on the driver to exercise vector search locally.                                     |
| PostgreSQL | `pg` + Docker Postgres           | When your production depends on pgvector / CITEXT / FTS tsvector.                                                                                                                                         |
| MySQL      | `mysql2` + Docker MySQL 9+       | When you use `VECTOR` or MySQL-specific features.                                                                                                                                                         |
| MongoDB    | `mongodb-memory-server` replset  | When your production uses transactions or Atlas Search (local approximates with text indexes only).                                                                                                       |
| Memory     | `@atscript/db-memory` (JS Maps)  | Fastest unit + trivial-table tests — no native module, no DB process, deterministic insertion order. JS-native filter/regex/null semantics (not SQL-parity); switch to SQLite for engine-fidelity checks. |

Default to SQLite for domain tests; switch engines only for engine-specific features.

## Wiring an in-memory SQLite adapter

```ts
import { DbSpace } from "@atscript/db";
import { syncSchema } from "@atscript/db/sync";
import { SqliteAdapter, BetterSqlite3Driver } from "@atscript/db-sqlite";
import { User, Post } from "../src/schema";

export async function makeTestDb() {
  const driver = new BetterSqlite3Driver(":memory:");
  const db = new DbSpace(() => new SqliteAdapter(driver));
  await syncSchema(db, [User, Post]);
  return {
    db,
    users: db.getTable(User),
    posts: db.getTable(Post),
    close: () => driver.close(), // release handles at end of suite
  };
}
```

- One fresh `DbSpace` per test (or per `beforeEach`) gives full isolation.
- `:memory:` databases are destroyed when the driver is closed.
- `syncSchema` is idempotent — safe to call in `beforeEach` even after the first run.

## Wiring a MongoDB in-memory server

```ts
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { MongoAdapter } from "@atscript/db-mongo";

let replset: MongoMemoryReplSet;
let client: MongoClient;

beforeAll(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = await MongoClient.connect(replset.getUri());
});
afterAll(async () => {
  await client.close();
  await replset.stop();
});

function makeTestDb() {
  return new DbSpace(() => new MongoAdapter(client.db("test-" + Math.random()), client));
}
```

A unique database name per spec avoids collection collisions across parallel suites. `MongoMemoryReplSet` is required for transactions (`.withTransaction()`).

## Seeding fixtures

```ts
const { users, posts } = await makeTestDb();
await users.insertMany([{ name: "Alice" }, { name: "Bob" }]);
await posts.insertOne({ authorId: 1, title: "Hello" });
```

For larger fixture sets, keep them close to the tests, one factory per domain:

```ts
// test/fixtures/blog.ts
export async function seedBlog(db: DbSpace) {
  const users = db.getTable(User)
  const posts = db.getTable(Post)
  await users.insertMany([...])
  await posts.insertMany([...])
}
```

## Resetting schema between tests

For full isolation prefer a fresh space per test. When that's too slow, truncate:

```ts
async function reset(db: DbSpace) {
  await db.getTable(Post).deleteMany({});
  await db.getTable(User).deleteMany({});
}
```

In SQLite with `:memory:`, closing the driver and creating a new space is the fastest reset — shared cache is process-local.

## Driving `moost-db` controllers from a test harness

Token-bound controllers (`@TableController(User)`) need only a registered space — one call, no DB connection, no import-order dance:

```ts
import { provideTestDbSpace, resetTestDbSpaces } from "@atscript/moost-db/testing";

beforeAll(() => provideTestDbSpace([User, Post])); // in-memory DbSpace + ambient registration
afterAll(() => resetTestDbSpaces());
```

`provideTestDbSpace(models?, { name?, space? })` returns the `DbSpace` for direct seeding/assertions; pass `space` to register your own (e.g. SQLite `:memory:`) instead of the memory adapter, `name` for non-default spaces.

`MoostHttp.listen()` returns `Promise<void>`, not a server handle. Two clean in-process options:

### Option A — in-process via `http.request()` (no TCP socket)

```ts
import { Moost } from "moost";
import { MoostHttp } from "@moostjs/event-http";
import { AsDbController, TableController } from "@atscript/moost-db";
import { provideTestDbSpace } from "@atscript/moost-db/testing";

@TableController(User) // token form — resolves from the test space at init()
class UsersController extends AsDbController<typeof User> {}

async function makeHarness() {
  provideTestDbSpace([User]);
  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(["users", UsersController]);
  await app.init();
  // http.request(url, init) runs the full Moost pipeline; no listener needed.
  return {
    fetch: (path: string, init?: RequestInit) => http.request(path, init),
  };
}

const { fetch } = await makeHarness();
const res = await fetch("/users/", {
  method: "POST",
  body: JSON.stringify({ name: "Alice" }),
});
```

### Option B — patch `globalThis.fetch` so `Client` works unchanged

```ts
import { enableLocalFetch } from "@moostjs/event-http";
import { Client } from "@atscript/db-client";

const restore = enableLocalFetch(http); // relative-path fetch → in-process Moost
const users = new Client<typeof User>("/users");
await users.insert({ name: "Alice" });
restore(); // teardown
```

### Option C — real socket on ephemeral port

```ts
let resolvedPort: number;
await http.listen(0, () => {
  const addr = http.getHttpApp().getServer()?.address();
  if (addr && typeof addr === "object") resolvedPort = addr.port;
});
// teardown: http.getHttpApp().getServer()?.close()
```

Prefer A or B for unit tests — no port allocation, no async lifecycle.

## Testing validation

Exercise the controller through HTTP so the validator runs in production mode:

```ts
const res = await fetch(url + "/users/", {
  method: "POST",
  body: JSON.stringify({ email: "bad" }),
});
expect(res.status).toBe(400);
const body = await res.json();
expect(body.errors).toContainEqual(expect.objectContaining({ path: "email" }));
```

For client-side validation only:

```ts
const v = await users.getValidator();
expect(() => v.validate({ email: "bad" }, "insert")).toThrow();
```

## Testing transactions

```ts
await expect(
  users.withTransaction(async () => {
    await users.insertOne({ name: "C" });
    throw new Error("rollback please");
  }),
).rejects.toThrow("rollback please");
expect(await users.count({})).toBe(previousCount);
```

MongoDB requires a replica-set test server for this to work.

## Testing FK cascades

Assert cascades end-to-end by seeding parent + child, deleting the parent, and checking the child state. Don't mock the integrity layer — the whole point is exercising it.

## Testing OCC

Versioned tables (`@db.column.version`) have three observable behaviors worth covering. See [versioning.md](versioning.md) for the feature reference.

```ts
// Auto-bump on every write
await users.insertOne({ id: "u1", name: "Ada" });
let row = await users.findOne({ filter: { id: "u1" } });
expect(row.version).toBe(0);
await users.updateOne({ id: "u1", name: "Ada L." });
row = await users.findOne({ filter: { id: "u1" } });
expect(row.version).toBe(1);

// CAS hit
const ok = await users.updateOne({ id: "u1", name: "x", $cas: { version: 1 } });
expect(ok.matchedCount).toBe(1);

// CAS miss — matchedCount = 0, no throw, row unchanged
const stale = await users.updateOne({ id: "u1", name: "y", $cas: { version: 1 } });
expect(stale.matchedCount).toBe(0);

// Direct write to version column throws DbError("VERSION_COLUMN_WRITE")
await expect(users.updateOne({ id: "u1", version: 99 })).rejects.toThrow();
```

For HTTP-level conflict shape, discriminate on `kind === "version_mismatch"` (NOT `error` — that's overridden by Wooks):

```ts
const res = await fetch(url + "/users/", {
  method: "PATCH",
  body: JSON.stringify({ id: "u1", name: "z", version: 0 /* stale */ }),
});
expect(res.status).toBe(409);
const body = await res.json();
expect(body.kind).toBe("version_mismatch");
expect(typeof body.currentVersion).toBe("number");
```

For the concurrent-race scenario, fire two PATCH calls in parallel against the running harness with the same `version`. Exactly one should return 200 and the other 409. Useful for guarding the "single-use credential" pattern (backup codes, magic links). Avoid asserting on adapter-internal SQL — assert only on the observable `matchedCount` / HTTP status.

## Parallel test runs

- SQLite `:memory:` + one `DbSpace` per spec → parallel-safe.
- One Postgres/MySQL schema per worker → parallel-safe.
- One Mongo database per spec → parallel-safe.

## Avoid

- Mocking `AtscriptDbTable` / `BaseDbAdapter` — adapter parity relies on exercising the real wiring.
- Asserting raw SQL — adapter output changes across versions.
