---
outline: deep
---

# CI/CD Integration

<!--@include: ../_experimental-warning.md-->

Schema sync integrates into deployment pipelines at multiple levels — from automatic dev sync to controlled production rollouts.

## Deployment Strategies

### Development — Auto-Sync on Startup

In development, sync on every application start. The [hash-based drift detection](./#hash-based-drift-detection) makes this effectively free when nothing has changed:

```typescript
if (process.env.NODE_ENV === "development") {
  const { syncSchema } = await import("@atscript/db/sync");
  await syncSchema(db, allTypes);
}
```

Or via CLI before starting the dev server:

```bash
npx asc db sync --yes && node server.js
```

### Staging — Dry-Run + Review

In staging, use `--dry-run` to preview changes, then apply with approval:

```bash
# CI step 1: preview
npx asc db sync --dry-run

# CI step 2: apply (after review)
npx asc db sync --yes
```

### Production — Safe Mode or Manual

For production, use `--safe` to ensure only additive changes are applied automatically. Destructive changes require manual intervention:

```bash
npx asc db sync --yes --safe
```

::: warning
Atscript does not generate rollback DDL. Destructive operations (column drops, type changes, table drops) cannot be undone automatically. Plan these carefully and consider backup strategies.
:::

## Dry-Run in CI Pipeline

Run `asc db sync --dry-run` as a CI check to detect unexpected schema changes early:

```yaml
# GitHub Actions example
- name: Schema sync check
  run: npx asc db sync --dry-run
  env:
    DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
```

The command exits with code 0 whether or not changes are detected. To fail the pipeline on pending changes, use the [programmatic API](./programmatic):

```typescript
import { SchemaSync } from "@atscript/db/sync";

const sync = new SchemaSync(db);
const plan = await sync.plan(types);

if (plan.status === "changes-needed") {
  const hasDestructive = plan.entries.some((e) => e.destructive);
  if (hasDestructive) {
    console.error("Destructive schema changes detected — manual review required");
    process.exit(1);
  }
}
```

## Distributed Locking Across Pods

When multiple pods start simultaneously (Kubernetes rolling deploys, serverless cold starts), the [distributed lock](./#distributed-locking) ensures only one process runs sync. The typical flow:

1. First pod acquires the lock, a heartbeat keeps it alive
2. Other pods wait, polling every 500ms
3. First pod completes sync, stores the new hash, releases the lock
4. Waiting pods see the updated hash → `synced-by-peer`, skip sync

See [Distributed Locking](./#distributed-locking) for the full protocol, heartbeat mechanics, and lock safety guarantees.

### Tuning lock parameters

For large deployments or slow databases, adjust via the [programmatic API](./programmatic):

```typescript
await syncSchema(db, types, {
  lockTtlMs: 60_000, // 60s TTL (default 30s) — heartbeat extends every 20s
  waitTimeoutMs: 180_000, // 3 min wait (default 60s)
  pollIntervalMs: 2000, // 2s poll (default 500ms)
});
```

## Serverless Considerations

Serverless functions (AWS Lambda, Vercel, Cloudflare Workers) present unique challenges:

- **Cold starts** — multiple instances may start simultaneously. The distributed lock handles this.
- **Short execution time** — sync must complete within the function timeout. The hash check (a single lightweight DB read when schema is unchanged) helps.
- **Connection limits** — each function instance opens a connection for sync. Consider connection pooling (e.g., RDS Proxy, PgBouncer).

For serverless, the hash check is critical — it ensures that the vast majority of cold starts skip the expensive introspection and DDL phases, requiring only a lightweight hash comparison against the control table.

## Example CI Pipeline

### GitHub Actions

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install

      # Preview schema changes
      - name: Schema sync dry-run
        run: npx asc db sync --dry-run
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}

      # Apply only additive changes
      - name: Apply schema sync
        run: npx asc db sync --yes --safe
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}

      # Deploy application
      - name: Deploy
        run: ./deploy.sh
```

### Generic CI

```bash
#!/bin/bash
set -e

# Step 1: Preview
echo "=== Schema sync preview ==="
npx asc db sync --dry-run

# Step 2: Apply in safe mode
echo "=== Applying safe changes ==="
npx asc db sync --yes --safe

# Step 3: Deploy
echo "=== Deploying ==="
# ... your deployment commands
```

## Rollback Considerations

Atscript schema sync is **forward-only** — there is no built-in down-migration or rollback mechanism.

**Additive changes** (new tables, new columns, new indexes) are generally safe — the old application version simply ignores the new columns.

**Destructive changes** require planning:

| Change              | Rollback Approach                      |
| ------------------- | -------------------------------------- |
| Add column          | Safe — old code ignores it             |
| Drop column         | Restore from backup or re-add manually |
| Rename column/table | Apply reverse rename annotation        |
| Type change         | Depends on data compatibility          |
| Drop table          | Restore from backup                    |

::: danger
Always back up your database before applying destructive schema changes in production. `--safe` mode prevents accidental destructive changes from reaching production.
:::

### Rename annotation lifecycle

See [Rename Tracking](./what-gets-synced#rename-tracking) for the full lifecycle of `@db.table.renamed`, `@db.column.renamed`, and `@db.view.renamed` annotations — including when to add and remove them.

## Next Steps

- [CLI](./cli) — command-line usage and flags
- [Programmatic API](./programmatic) — using sync from code
- [What Gets Synced](./what-gets-synced) — detailed change categories
