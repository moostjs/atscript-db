# moost-db

`@atscript/moost-db` exposes a table/view as a Moost HTTP controller.

## Install

```bash
pnpm add @atscript/moost-db @moostjs/event-http moost
```

## Write controller (full CRUD)

```ts
import { AsDbController, TableController } from "@atscript/moost-db";
import { Todo } from "./todo.as";
import { todosTable } from "./db";

@TableController(todosTable) // Provide + Controller + Inherit
export class TodoController extends AsDbController<typeof Todo> {}
```

Register:

```ts
import { Moost } from "moost";
import { MoostHttp } from "@moostjs/event-http";

const app = new Moost();
app.adapter(new MoostHttp()).listen(3000);
app.registerControllers(["todos", TodoController]); // URL prefix segment
await app.init();
```

## Read-only controller (views, public read endpoints)

```ts
import { AsDbReadableController, ReadableController } from "@atscript/moost-db";
import { activeTasksView } from "./db";

@ReadableController(activeTasksView)
export class ActiveTasksController extends AsDbReadableController<typeof ActiveTasks> {}
```

## Generated routes

| Method | Path           | Purpose                                                                | Class                    |
| ------ | -------------- | ---------------------------------------------------------------------- | ------------------------ |
| GET    | `/query`       | Query rows (or `$count`, or `$groupBy` aggregate).                     | `AsDbReadableController` |
| GET    | `/pages`       | Paginated query. Returns `{ data, page, itemsPerPage, pages, count }`. | `AsDbReadableController` |
| GET    | `/one/:id`     | Single row by scalar PK.                                               | `AsDbReadableController` |
| GET    | `/one?a=1&b=2` | Single row by composite PK / compound unique.                          | `AsDbReadableController` |
| GET    | `/meta`        | Serialized type + relations + field capability map.                    | `AsDbReadableController` |
| POST   | `/`            | Insert one or many (array body → `insertMany`).                        | `AsDbController`         |
| PUT    | `/`            | Replace one or many by PK.                                             | `AsDbController`         |
| PATCH  | `/`            | Update one or many by PK.                                              | `AsDbController`         |
| DELETE | `/:id`         | Delete by scalar PK.                                                   | `AsDbController`         |
| DELETE | `/?a=1&b=2`    | Delete by composite PK / compound unique.                              | `AsDbController`         |

`ViewController` is an alias for `ReadableController` — same behaviour, different label.

## `@db.http.path` resolution

- If an author writes `@db.http.path '/authors'`, `TableController` / `ReadableController` uses that as the controller prefix when no explicit `prefix` arg is passed.
- At runtime the controller writes the final absolute path (Moost `globalPrefix` + computed prefix, leading `/`) back onto `type.metadata["db.http.path"]`.
- The `/meta` endpoint exposes this value so FK references carry the correct URL for browser value-help pickers.

## Hooks (override on subclass)

```ts
@TableController(usersTable)
export class UsersController extends AsDbController<typeof User> {
  protected transformFilter(filter) {
    return { ...filter, tenantId: useTenant() };
  }
  protected transformProjection(sel) {
    return sel;
  }
  protected async onWrite(action, data) {
    return this.sanitize(data);
  } // return undefined to abort
  protected async onRemove(id) {
    return id;
  }
  protected computeEmbedding(text: string) {
    return myEmbed.embed(text);
  } // enables $vector
}
```

- `transformFilter` / `transformProjection` may be async (session / ACL lookups).
- `onWrite` / `onRemove` returning `undefined` aborts with HTTP 500 (override to throw a richer error).
- `computeEmbedding` enables `$vector` on `/query` — without it, `$vector` → HTTP 501.

## Gate mode

- `@db.table.filterable 'manual'` + `@db.column.filterable` → server rejects any `/query` filter referencing fields lacking the field-level annotation. HTTP 400 with `path` pointing to the offending field.
- `@db.table.sortable 'manual'` + `@db.column.sortable` → same for sort keys.
- `/meta` reflects the gate: `fields[<path>].filterable` / `.sortable` mirror what the server will accept.

## Errors

Write endpoints run the server validator for the matching mode (`insert` / `patch` / `replace`). Both `ValidatorError` and `DbError` are transformed to:

```json
{
  "statusCode": 400,
  "message": "...",
  "errors": [{ "path": "email", "message": "Expected email format" }]
}
```

Status-code mapping (`validation-interceptor.ts`):

| Source                                                                                                     | HTTP |
| ---------------------------------------------------------------------------------------------------------- | ---- |
| `ValidatorError`                                                                                           | 400  |
| `DbError` code `CONFLICT`                                                                                  | 409  |
| `DbError` any other code (`FK_VIOLATION`, `NOT_FOUND`, `CASCADE_CYCLE`, `INVALID_QUERY`, `DEPTH_EXCEEDED`) | 400  |

## Value-help controllers

`AsReadableController`, `AsValueHelpController`, and `AsJsonValueHelpController` back non-DB `@db.rel.FK` sources (enums, static lists, JSON documents) so forms can resolve picker URLs from `@db.http.path` regardless of whether the target is a table. Typical wiring:

```ts
import { AsValueHelpController, ReadableController } from "@atscript/moost-db";

@ReadableController(RolesDictionary) // an interface with @db.rel.FK target fields
export class RolesController extends AsValueHelpController<typeof RolesDictionary> {
  // Override source(): returns the in-memory list.
}
```

`AsJsonValueHelpController` loads entries from a JSON file at startup.

## Meta endpoint shape

```ts
interface TMetaResponse {
  searchable: boolean;
  vectorSearchable: boolean;
  searchIndexes: { name; description?; type? }[];
  primaryKeys: string[];
  readOnly: boolean;
  relations: { name; direction: "to" | "from" | "via"; isArray }[];
  fields: Record<string, { sortable; filterable }>;
  type: TSerializedAnnotatedType; // refDepth = (@db.deep.insert N) + 0.5
}
```

Consumed by `@atscript/db-client` to build a client-side validator matching the server's.

Wire CORS / auth / rate-limiting as Moost interceptors (`@Intercept`) — routes from `AsDbController`/`AsDbReadableController` participate normally.
