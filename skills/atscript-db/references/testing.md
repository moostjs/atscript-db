# testing

Patterns for testing **an application that consumes atscript-db** — not for testing atscript-db itself.

## Test DB choices

| Stack      | Engine                           | Use when                                                                                            |
| ---------- | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| SQLite     | `better-sqlite3` with `:memory:` | Default for unit + integration. Synchronous, zero setup, adapter-parity holds.                      |
| PostgreSQL | `pg` + Docker Postgres           | When your production depends on pgvector / CITEXT / FTS tsvector.                                   |
| MySQL      | `mysql2` + Docker MySQL 9+       | When you use `VECTOR` or MySQL-specific features.                                                   |
| MongoDB    | `mongodb-memory-server` replset  | When your production uses transactions or Atlas Search (local approximates with text indexes only). |

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

Mount the controller in a Moost app with `MoostHttp` on an ephemeral port, then call it with `fetch`:

```ts
import { Moost } from "moost";
import { MoostHttp } from "@moostjs/event-http";
import { AsDbController, TableController } from "@atscript/moost-db";

@TableController(usersTable)
class UsersController extends AsDbController<typeof User> {}

async function makeServer() {
  const app = new Moost();
  const http = new MoostHttp();
  app.adapter(http);
  app.registerControllers(["users", UsersController]);
  await app.init();
  const server = await http.listen(0); // random port
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => http.close(),
  };
}
```

Then drive via `@atscript/db-client`:

```ts
import { Client } from "@atscript/db-client";

const { url, close } = await makeServer();
const users = new Client<typeof User>(url + "/users");
await users.insert({ name: "Alice" });
const all = await users.query();
await close();
```

Or with raw `fetch` when asserting URL shape.

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

## Parallel test runs

- SQLite `:memory:` + one `DbSpace` per spec → parallel-safe.
- One Postgres/MySQL schema per worker → parallel-safe.
- One Mongo database per spec → parallel-safe.

## Avoid

- Mocking `AtscriptDbTable` / `BaseDbAdapter` — adapter parity relies on exercising the real wiring.
- Asserting raw SQL — adapter output changes across versions.
