---
outline: deep
---

# CLI

<!--@include: ../_experimental-warning.md-->

The `asc db sync` command compares your `.as` definitions against the live database and applies changes. It is part of the `@atscript/typescript` CLI.

## Basic Usage

```bash
npx asc db sync
```

This will:

1. Compile your `.as` files
2. Connect to the database using your [config](./configuration)
3. Show a detailed plan of what will change
4. Ask for confirmation before applying destructive changes
5. Apply changes and show the result

If the schema hash is unchanged since the last sync, the command exits after a quick hash comparison — no schema introspection, no DDL, no locking.

## Flags

| Flag           | Description                                                           |
| -------------- | --------------------------------------------------------------------- |
| `--dry-run`    | Show the plan without applying any changes                            |
| `--yes`        | Skip the confirmation prompt (CI mode)                                |
| `--force`      | Re-sync even if the schema hash matches                               |
| `--safe`       | Skip destructive operations (column drops, table drops, type changes) |
| `-c, --config` | Path to `atscript.config.mts` (auto-resolved if omitted)              |

### `--dry-run`

Shows exactly what would change without touching the database. Use this to preview changes before applying:

```bash
npx asc db sync --dry-run
```

### `--yes`

Skips the interactive confirmation prompt. Non-destructive changes are always applied without prompting; `--yes` extends this to destructive changes as well:

```bash
npx asc db sync --yes
```

### `--force`

Bypasses the [hash-based drift detection](./#hash-based-drift-detection). The command will introspect the database and diff against your `.as` definitions regardless of whether the stored hash matches:

```bash
npx asc db sync --force
```

### `--safe`

Suppresses all destructive operations (column drops, table drops, type changes requiring recreation). Only additive changes are applied. See [Safe Mode](./#safe-mode) for details.

```bash
npx asc db sync --safe
```

## Output Format

The CLI displays a structured plan grouped by tables and views. Each entry shows a status indicator:

| Symbol | Color | Meaning                                      |
| ------ | ----- | -------------------------------------------- |
| `+`    | Green | New table/column/FK will be created          |
| `~`    | Cyan  | Existing table will be modified              |
| `-`    | Red   | Table/column/FK will be dropped              |
| `!`    | Red   | Type change or destructive operation         |
| `✓`    | Green | Already in sync                              |
| `✗`    | Red   | Error (rename conflict, missing sync method) |

### Example output

```
Tables:
  + users — create
      + id (number) PK — add
      + name (string) — add
      + email (string) — add

  ~ posts — alter
      + published_at (number) — add
      ~ title_text → title — rename
      - old_column — drop

  ✓ comments — in sync

Views:
  + active_users — create
  ✓ [V] user_stats — in sync
```

After applying changes, the result summary shows what was actually done:

```
Schema synced successfully. Hash: a1b2c3d4

Tables:
  + users — created
      + id — added
      + name — added
      + email — added

  ~ posts — altered
      + published_at — added
      ~ title_text — renamed
      - old_column — dropped
```

## Examples

Preview changes without applying:

```bash
npx asc db sync --dry-run
```

Auto-approve for CI/CD pipelines:

```bash
npx asc db sync --yes
```

Safe mode — only additive changes:

```bash
npx asc db sync --safe
```

Force a full re-sync, ignoring the stored hash:

```bash
npx asc db sync --force
```

Use a specific config file:

```bash
npx asc db sync -c ./config/atscript.config.mts
```

Combine flags for CI with safe mode:

```bash
npx asc db sync --yes --safe
```

## Error Handling

The CLI exits with a non-zero code when:

- **No `db` config** — the `atscript.config.mts` has no `db` field
- **Schema errors** — rename conflicts, type changes without `@db.sync.method`, or external view validation failures
- **Adapter not found** — the specified adapter package is not installed

When errors are detected in the plan, the CLI prints the errors and exits without applying any changes.

## Next Steps

- [Configuration](./configuration) — config file setup for schema sync
- [What Gets Synced](./what-gets-synced) — detailed change categories
- [How Sync Works](./) — architecture and internals
