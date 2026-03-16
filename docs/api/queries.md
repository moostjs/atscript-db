---
outline: deep
---

# Queries & Filters

Every query in Atscript's DB layer follows the same shape: a **filter** that selects which records to return, and a **controls** object that determines how they come back (sorting, pagination, projection). This syntax is consistent across all adapters.

```typescript
const results = await table.findMany({
  filter: {
    /* which records */
  },
  controls: {
    /* how to return them */
  },
});
```

## Filter Syntax

Filters use a MongoDB-inspired expression language. At its simplest, you pass an object whose keys are field names and whose values are the conditions to match.

### Equality

The most common filter is a direct equality check:

```typescript
// Shorthand — value is the match target
{
  filter: {
    status: "active";
  }
}

// Explicit operator form
{
  filter: {
    status: {
      $eq: "active";
    }
  }
}
```

Multiple fields in the same object are combined with AND:

```typescript
{ filter: { status: 'active', role: 'admin' } }
// WHERE status = 'active' AND role = 'admin'
```

### Not Equal

```typescript
{
  filter: {
    status: {
      $ne: "done";
    }
  }
}
// WHERE status != 'done'
```

### Comparisons

```typescript
{
  filter: {
    age: {
      $gt: 18;
    }
  }
} // greater than
{
  filter: {
    age: {
      $gte: 18;
    }
  }
} // greater than or equal
{
  filter: {
    age: {
      $lt: 65;
    }
  }
} // less than
{
  filter: {
    age: {
      $lte: 65;
    }
  }
} // less than or equal
```

These operators are available on `number`, `string`, and `Date` fields.

### Set Operators

Check whether a value belongs (or does not belong) to a set:

```typescript
{
  filter: {
    role: {
      $in: ["admin", "editor"];
    }
  }
}
// WHERE role IN ('admin', 'editor')

{
  filter: {
    status: {
      $nin: ["archived", "deleted"];
    }
  }
}
// WHERE status NOT IN ('archived', 'deleted')
```

### Pattern Matching

```typescript
{
  filter: {
    name: {
      $regex: "^Al";
    }
  }
}
// SQLite/PostgreSQL: WHERE name LIKE 'Al%' (or REGEXP)
// MongoDB: WHERE name matches /^Al/
```

`$regex` is available on `string` fields and accepts a `RegExp` or `string`.

### Existence

Test whether a field is present (non-null) or absent (null):

```typescript
{
  filter: {
    email: {
      $exists: true;
    }
  }
} // WHERE email IS NOT NULL
{
  filter: {
    email: {
      $exists: false;
    }
  }
} // WHERE email IS NULL
```

### Null Values

You can also filter for null directly:

```typescript
{
  filter: {
    assigneeId: null;
  }
}
// WHERE assigneeId IS NULL
```

## Logical Operators

### Implicit AND

When you put multiple fields in a single filter object, they are ANDed together automatically:

```typescript
{ filter: { status: 'active', role: 'admin' } }
```

### Explicit AND

Use `$and` when you need multiple conditions on the same field, or just prefer being explicit:

```typescript
{
  filter: {
    $and: [{ age: { $gte: 18 } }, { age: { $lt: 65 } }];
  }
}
```

### OR

```typescript
{
  filter: {
    $or: [{ status: "active" }, { role: "admin" }];
  }
}
```

### NOT

Negate a set of conditions:

```typescript
{
  filter: {
    $not: {
      status: "archived";
    }
  }
}
```

### Nested Combinations

Logical operators compose naturally:

```typescript
{ filter: {
  $and: [
    { $or: [
      { priority: 'high' },
      { priority: 'critical' },
    ] },
    { $not: { status: 'done' } },
  ],
} }
```

## Nested Field Filters

Atscript automatically flattens nested objects into `__`-separated column names (e.g., a `contact.email` field becomes the `contact__email` column). When filtering, use **dot notation** — the adapter translates it to the physical column name:

```typescript
{ filter: { 'contact.email': 'alice@example.com' } }
// SQL: WHERE contact__email = 'alice@example.com'

{ filter: { 'address.city': { $in: ['Berlin', 'Paris'] } } }
// SQL: WHERE address__city IN ('Berlin', 'Paris')
```

This works with all operators — comparisons, `$regex`, `$exists`, and logical combinators.

## Query Controls

The `controls` object determines how the result set is shaped.

### Sorting

Use `$sort` with `1` for ascending and `-1` for descending:

```typescript
controls: {
  $sort: {
    name: 1;
  }
} // A → Z
controls: {
  $sort: {
    createdAt: -1;
  }
} // newest first
```

Multiple sort keys are applied in order:

```typescript
controls: { $sort: { status: 1, name: -1 } }
// ORDER BY status ASC, name DESC
```

### Pagination

```typescript
controls: {
  $limit: 10,   // return at most 10 records
  $skip: 20,    // skip the first 20 records
}
```

### Field Selection

Include specific fields using array form:

```typescript
controls: {
  $select: ["id", "name", "email"];
}
```

Or exclude fields with an object where `0` means exclude:

```typescript
controls: { $select: { password: 0, internalNotes: 0 } }
```

When selecting a nested object parent, all its child fields are included:

```typescript
controls: {
  $select: ["id", "contact"];
}
// Includes contact.email, contact.phone, etc.
```

::: tip FK Fields Auto-Included
When using `$select` with relation loading (`$with`), foreign key fields needed for relation resolution (e.g., `assigneeId` for an `assignee` relation) are automatically included even if not listed in `$select`.
:::

### Paginated Results

Use `findManyWithCount()` to get both data and total count in one call — see [CRUD Operations — Find Many with Count](/api/crud#find-many-with-count) for the API and examples.

## Type-Safe Generics

Queries are fully typed. `findOne` and `findMany` accept a `Uniquery<OwnProps, NavType>` that constrains filter fields to own (non-navigation) properties. The return type `DbResponse` automatically strips navigation properties from the result unless you request them via `$with`.

When the query type is a literal (not widened), TypeScript infers exactly which navigation properties are returned:

```typescript
// result type includes `assignee` but not other nav props
const tasks = await taskTable.findMany({
  controls: { $with: [{ name: "assignee" }] },
});
```

## Query Expressions

Query expressions are a **compile-time** syntax used inside `.as` files to define view filters, join conditions, and relation filters. They are _not_ used in runtime TypeScript queries — they are embedded in annotations and compiled into the schema.

### Syntax

Expressions are wrapped in backticks inside `.as` files:

```atscript
@db.view.filter `Task.status != 'done'`
```

### Field References

Reference fields using `TableName.fieldName`:

```atscript
@db.view.filter `Task.priority = 'high'`
@db.view.joins Project, `Project.id = Task.projectId`
```

### Operators

| Operator | Meaning               | Example                        |
| -------- | --------------------- | ------------------------------ |
| `=`      | equals                | `` `Task.status = 'active'` `` |
| `!=`     | not equals            | `` `Task.status != 'done'` ``  |
| `>`      | greater than          | `` `Task.priority > 3` ``      |
| `>=`     | greater than or equal | `` `Task.priority >= 3` ``     |
| `<`      | less than             | `` `Task.age < 65` ``          |
| `<=`     | less than or equal    | `` `Task.age <= 65` ``         |
| `~=`     | regex match           | `` `User.name ~= '^Al'` ``     |
| `?`      | exists (non-null)     | `` `Task.assigneeId ?` ``      |
| `!?`     | not exists (null)     | `` `Task.deletedAt !?` ``      |

### Set Membership

Use curly braces for IN / NOT IN:

```atscript
@db.view.filter `Task.status {active, pending}`
@db.view.filter `Task.role !{guest, bot}`
```

### Logical Combinators

Combine conditions with `&&` (and), `||` (or), and `!()` (not). Use parentheses for grouping:

```atscript
@db.view.filter `Task.status != 'done' && Task.priority >= 3`
@db.view.filter `(Task.status = 'active' || Task.status = 'pending') && Task.assigneeId ?`
@db.view.filter `!(Task.status = 'archived')`
```

### Where They Are Used

Query expressions appear in these annotations:

- **`@db.view.filter`** — row-level filter for a [view](/views/)
- **`@db.view.joins`** — join condition between tables in a view
- **`@db.view.having`** — having clause for aggregation views
- **`@db.rel.filter`** — static filter applied when loading a relation

Example in a view definition:

```atscript
@db.view
@db.view.for Task
@db.view.joins Project, `Project.id = Task.projectId`
@db.view.filter `Task.status != 'done' && Task.priority >= 3`
type ActiveHighPriorityTasks {
  taskId: Task.id
  title: Task.title
  projectName: Project.name
}
```

## Combining It All

A practical example that brings filters, sorting, pagination, and field selection together:

```typescript
const tasks = await taskTable.findMany({
  filter: {
    status: { $ne: "done" },
    priority: { $in: ["high", "critical"] },
    "project.active": true,
  },
  controls: {
    $sort: { priority: -1, createdAt: 1 },
    $limit: 20,
    $skip: 0,
    $select: ["id", "title", "status", "priority"],
  },
});
```

This returns the first 20 non-done tasks with high or critical priority from active projects, sorted by priority descending then creation date ascending, with only the selected fields.

## Next Steps

- [CRUD Operations](/api/crud) — Insert, read, update, delete
- [Update & Patch](/api/update-patch) — Embedded array and object patch operators
- [Views](/views/) — Managed, external, and materialized views
- [Relations](/relations/deep-operations) — Navigation property loading and deep operations
