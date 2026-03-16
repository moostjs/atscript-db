---
outline: deep
---

# Customization

`AsDbController` and `AsDbReadableController` expose protected hooks that let you extend default behavior without reimplementing endpoints. Override the hooks you need to add access control, data transformation, and business logic.

## Available Hooks

All hooks are protected methods with sensible defaults (pass-through or no-op). Override only the ones you need.

| Hook                                   | Available On   | Called When                  | Purpose                                  |
| -------------------------------------- | -------------- | ---------------------------- | ---------------------------------------- |
| `transformFilter(filter)`              | Both           | Before every read            | Modify filters (add tenant, soft-delete) |
| `transformProjection(projection)`      | Both           | Before every read            | Restrict visible fields                  |
| `validateInsights(insights)`           | Both           | After query parsing          | Field-level access control               |
| `computeEmbedding(search, fieldName?)` | Both           | When `$vector` is present    | Convert text to embedding vector         |
| `onWrite(action, data)`                | AsDbController | Before insert/replace/update | Transform or reject write data           |
| `onRemove(id)`                         | AsDbController | Before delete                | Allow or prevent deletion                |
| `init()`                               | Both           | On controller construction   | One-time setup                           |

## Read Hooks

### transformFilter {#transformfilter}

Receives the parsed filter expression and returns a modified one. Every query passes through this hook, making it ideal for cross-cutting read concerns.

**Multi-tenant filtering:**

```typescript
@TableController(todosTable)
export class TodoController extends AsDbController<typeof Todo> {
  protected transformFilter(filter: FilterExpr): FilterExpr {
    const tenantId = this.getCurrentTenantId();
    return { $and: [filter, { tenantId }] };
  }
}
```

The returned filter replaces the original for all read endpoints (`/query`, `/pages`, `/one/:id`).

**Soft deletes:**

```typescript
protected transformFilter(filter: FilterExpr): FilterExpr {
  return { $and: [filter, { deletedAt: { $exists: false } }] }
}
```

### transformProjection {#transformprojection}

Intercepts the projection before every read. If the client sends `$select`, `projection` contains it; otherwise it is `undefined`. Use this to enforce field exclusions:

```typescript
protected transformProjection(projection?: UniqueryControls['$select']) {
  return projection ?? { password: 0, apiKey: 0, secret: 0 }
}
```

When `projection` is `undefined` (no `$select` from the client), the hook supplies a default exclusion list. When the client does send `$select`, you can merge or override as needed.

### validateInsights {#validateinsights}

Runs after the URL query string is parsed. The `insights` map contains every field referenced in the query — whether in a filter, projection, or sort order. Return a string to reject with HTTP `400`, or `undefined` to allow.

```typescript
const RESTRICTED_FIELDS = new Set(['salary', 'ssn', 'internalNotes'])

protected validateInsights(insights: Map<string, unknown>): string | undefined {
  // Run the default validation first (rejects unknown fields)
  const base = super.validateInsights(insights)
  if (base) return base

  const user = this.getCurrentUser()
  if (!user?.isAdmin) {
    for (const field of insights.keys()) {
      if (RESTRICTED_FIELDS.has(field)) {
        return `Access denied: cannot query field "${field}"`
      }
    }
  }
  return undefined
}
```

This catches every reference to a restricted field — whether in a filter (`salary>=100000`), a projection (`$select=ssn`), or a sort order (`$sort=salary`).

### computeEmbedding {#computeembedding}

Called when `$vector` is present in query controls. Receives the search text and an optional field name. Must return a `number[]` (the embedding vector).

The default implementation throws HTTP `501 Not Implemented`.

```typescript
@TableController(articlesTable)
export class ArticlesController extends AsDbController<typeof Article> {
  protected async computeEmbedding(search: string, fieldName?: string): Promise<number[]> {
    // Use any embedding provider (OpenAI, Cohere, local model, etc.)
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: search,
    });
    return response.data[0].embedding;
  }
}
```

The `fieldName` parameter identifies which vector field was specified in `$vector`, allowing different embedding models per field if needed.

See [Vector Search in URLs](./advanced#vector-search) for how this hook integrates with the URL parameters.

## Write Hooks

### onWrite {#onwrite}

Intercepts all write operations before they reach the database. Return the (possibly modified) data to proceed, or `undefined` to abort (returns HTTP `500`).

The `action` parameter identifies the operation:

| Action        | Triggered By               |
| ------------- | -------------------------- |
| `insert`      | `POST /` with object body  |
| `insertMany`  | `POST /` with array body   |
| `replace`     | `PUT /` with object body   |
| `replaceMany` | `PUT /` with array body    |
| `update`      | `PATCH /` with object body |
| `updateMany`  | `PATCH /` with array body  |

**Audit fields:**

```typescript
protected onWrite(
  action: 'insert' | 'insertMany' | 'replace' | 'replaceMany' | 'update' | 'updateMany',
  data: unknown
) {
  const record = data as Record<string, unknown>
  if (action === 'insert') {
    return { ...record, createdBy: this.getCurrentUserId() }
  }
  if (action === 'update') {
    return { ...record, updatedBy: this.getCurrentUserId() }
  }
  return data
}
```

**Authorization:**

```typescript
protected onWrite(action: string, data: unknown) {
  if (!this.getCurrentUser()?.canWrite) {
    return undefined  // abort — returns HTTP 500
  }
  return data
}
```

### onRemove {#onremove}

Intercepts DELETE requests. Receives the record ID (a string for single-key tables, or an object for composite keys). Return the ID to proceed with deletion, or `undefined` to abort (returns HTTP `500`).

**Delete guard:**

```typescript
protected async onRemove(id: unknown) {
  const record = await this.table.findById(id as string)
  if (record?.protected) {
    return undefined  // abort
  }
  return id
}
```

**Soft delete (replace DELETE with UPDATE):**

```typescript
protected async onRemove(id: unknown) {
  await this.table.updateOne({ id, deletedAt: Date.now() } as any)
  return undefined  // prevent actual deletion
}
```

When `onRemove` returns `undefined`, the controller aborts the DELETE operation and returns HTTP `500`. Combine with `transformFilter` to exclude soft-deleted records from reads.

## Initialization

### init {#init}

Runs once during controller construction. Use it for schema setup, seeding, or registering watchers. Can be async — errors are caught and logged automatically.

```typescript
protected async init() {
  await this.table.ensureTable()
  await this.table.syncIndexes()
}
```

## Accessing the Underlying Table

Inside any hook or custom method, you have access to the underlying table instance:

```typescript
this.table; // AtscriptDbTable — full read/write access (AsDbController only)
this.readable; // AtscriptDbReadable — read-only access (both controllers)
```

Both controllers expose `this.readable`. The writable `this.table` property is only available on `AsDbController`.

```typescript
// In any hook or custom method
const count = await this.readable.count({ filter: {}, controls: {} });
this.logger.info(`Primary keys: ${this.table.primaryKeys}`);
this.logger.info(`Indexes: ${this.table.indexes.size}`);
```

## Extending Controllers

### Adding Custom Routes

Add methods with Moost decorators to create custom endpoints alongside the generated ones:

```typescript
import { Get } from "@moostjs/event-http";

@TableController(todosTable)
export class TodoController extends AsDbController<typeof Todo> {
  @Get("stats")
  async getStats() {
    const total = await this.readable.count({ filter: {}, controls: {} });
    const completed = await this.readable.count({
      filter: { completed: true },
      controls: {},
    });
    return { total, completed, pending: total - completed };
  }
}
```

This adds `GET /todos/stats` alongside the generated CRUD endpoints.

### Multiple Controllers

Mount multiple tables and views on different prefixes:

```typescript
app.registerControllers(
  ["todos", TodoController],
  ["projects", ProjectController],
  ["active-tasks", ActiveTasksViewController], // read-only view
);
```

## Combined Example

A complete controller combining multi-tenancy, audit fields, soft deletes, and field restrictions:

```typescript
const RESTRICTED = new Set(["internalNotes", "costPrice"]);

@TableController(productsTable, "api/products")
export class ProductController extends AsDbController<typeof Product> {
  protected async init() {
    await this.table.ensureTable();
  }

  protected transformFilter(filter: FilterExpr): FilterExpr {
    return {
      $and: [
        filter,
        {
          tenantId: this.getTenantId(),
          deletedAt: { $exists: false },
        },
      ],
    };
  }

  protected transformProjection(projection?: UniqueryControls["$select"]) {
    return projection ?? { costPrice: 0 };
  }

  protected onWrite(action: string, data: unknown) {
    const record = data as Record<string, unknown>;
    if (action === "insert") {
      return {
        ...record,
        tenantId: this.getTenantId(),
        createdBy: this.getUserId(),
      };
    }
    return {
      ...record,
      tenantId: this.getTenantId(),
      updatedBy: this.getUserId(),
    };
  }

  protected async onRemove(id: unknown) {
    await this.table.updateOne({ id, deletedAt: Date.now() } as any);
    return undefined; // soft delete
  }

  protected validateInsights(insights: Map<string, unknown>): string | undefined {
    const base = super.validateInsights(insights);
    if (base) return base;

    for (const field of insights.keys()) {
      if (RESTRICTED.has(field) && !this.isAdmin()) {
        return `Access denied: cannot query field "${field}"`;
      }
    }
    return undefined;
  }
}
```

## Next Steps

- [HTTP Setup](./) — Controller installation and wiring
- [CRUD Endpoints](./crud) — Endpoint reference
- [CRUD Operations](/api/crud) — Programmatic `AtscriptDbTable` API
- [Transactions](/api/transactions) — Transaction integration
