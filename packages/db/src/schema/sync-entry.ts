import type { TDbFieldMeta, TTableOptionDiff } from "../types";

// ── Colors ───────────────────────────────────────────────────────────────

export interface TSyncColors {
  green(s: string): string;
  red(s: string): string;
  cyan(s: string): string;
  yellow(s: string): string;
  bold(s: string): string;
  dim(s: string): string;
  underline(s: string): string;
}

const noColor: TSyncColors = {
  green: (s) => s,
  red: (s) => s,
  cyan: (s) => s,
  yellow: (s) => s,
  bold: (s) => s,
  dim: (s) => s,
  underline: (s) => s,
};

// ── SyncEntry ────────────────────────────────────────────────────────────

export type TSyncEntryStatus = "create" | "alter" | "drop" | "in-sync" | "error";

/**
 * Desired work safe mode did not apply (since 0.1.128): the primary-key
 * rebuild, the `@db.sync.method 'drop'` recreate of a type change, the
 * recreate a destructive table-option change needs, and nullable/default
 * changes on adapters that need DDL for them.
 */
export type TSyncSkippedWork = "pk-rebuild" | "recreate" | "table-options" | "nullable-defaults";

export interface TSyncEntryInit {
  name: string;
  /** 'V' = virtual view, 'M' = materialized view, 'E' = external view, undefined = table */
  viewType?: "V" | "M" | "E";
  status: TSyncEntryStatus;
  syncMethod?: "drop" | "recreate";
  columnsToAdd?: TDbFieldMeta[];
  columnsToRename?: Array<{ from: string; to: string }>;
  typeChanges?: Array<{ column: string; fromType: string; toType: string }>;
  nullableChanges?: Array<{ column: string; toNullable: boolean }>;
  defaultChanges?: Array<{ column: string; oldDefault?: string; newDefault?: string }>;
  columnsToDrop?: string[];
  optionChanges?: TTableOptionDiff["changed"];
  fkAdded?: Array<{ fields: string[]; targetTable: string }>;
  fkRemoved?: Array<{ fields: string[]; targetTable: string }>;
  fkChanged?: Array<{ fields: string[]; targetTable: string; details: string }>;
  columnsAdded?: string[];
  columnsRenamed?: string[];
  columnsDropped?: string[];
  recreated?: boolean;
  errors?: string[];
  renamedFrom?: string;
  /**
   * The table's primary-key field set changes. `rebuild: true` when sync
   * rebuilds the key (empty table); `false` when the rebuild is skipped
   * (safe mode). A populated table is refused instead (see `refused`).
   * @since 0.1.128
   */
  pkChange?: { from: string[]; to: string[]; rebuild: boolean };
  /**
   * The work safe mode skipped on this table: `"pk-rebuild"` (`pkChange`
   * kept with `rebuild: false`), `"recreate"` (`typeChanges` kept),
   * `"table-options"` (`optionChanges` kept) and `"nullable-defaults"`
   * (`nullableChanges` / `defaultChanges` kept). Each is pending: the
   * table's snapshot and the schema hash are withheld, and the next run
   * without `safe` applies it. Printed as `… — skipped (safe mode)`.
   * Identical in the plan and in the run.
   * @since 0.1.128
   */
  skipped?: ReadonlyArray<TSyncSkippedWork>;
  /**
   * Names of the tables this entry's DDL waits for (FK parents for tables,
   * entry/join tables for views, referencing children for drops).
   * Informational — schema sync already executes in that order.
   * @since 0.1.128
   */
  dependsOn?: string[];
  /**
   * Present when the table is dropped together with the other members of a
   * foreign-key cycle (one group operation).
   * @since 0.1.128
   */
  dropGroup?: string[];
  /**
   * `true` when this `error` entry is a pre-flight refusal: schema sync
   * detected a change it cannot apply safely and issued no DDL at all.
   * @since 0.1.128
   */
  refused?: boolean;
}

export class SyncEntry {
  readonly name: string;
  /** 'V' = virtual view, 'M' = materialized view, 'E' = external view, undefined = table */
  readonly viewType?: "V" | "M" | "E";
  readonly status: TSyncEntryStatus;
  readonly syncMethod?: "drop" | "recreate";

  // Plan fields
  readonly columnsToAdd: TDbFieldMeta[];
  readonly columnsToRename: Array<{ from: string; to: string }>;
  readonly typeChanges: Array<{ column: string; fromType: string; toType: string }>;
  readonly nullableChanges: Array<{ column: string; toNullable: boolean }>;
  readonly defaultChanges: Array<{ column: string; oldDefault?: string; newDefault?: string }>;
  readonly columnsToDrop: string[];
  readonly optionChanges: TTableOptionDiff["changed"];
  readonly fkAdded: Array<{ fields: string[]; targetTable: string }>;
  readonly fkRemoved: Array<{ fields: string[]; targetTable: string }>;
  readonly fkChanged: Array<{ fields: string[]; targetTable: string; details: string }>;

  // Result fields
  readonly columnsAdded: string[];
  readonly columnsRenamed: string[];
  readonly columnsDropped: string[];
  readonly recreated: boolean;
  readonly errors: string[];
  readonly renamedFrom?: string;
  /** @since 0.1.128 — see {@link TSyncEntryInit.pkChange}. */
  readonly pkChange?: { from: string[]; to: string[]; rebuild: boolean };
  /** @since 0.1.128 — see {@link TSyncEntryInit.skipped}. */
  readonly skipped: ReadonlyArray<TSyncSkippedWork>;
  /** @since 0.1.128 — see {@link TSyncEntryInit.dependsOn}. */
  readonly dependsOn: string[];
  /** @since 0.1.128 — see {@link TSyncEntryInit.dropGroup}. */
  readonly dropGroup?: string[];
  /** @since 0.1.128 — see {@link TSyncEntryInit.refused}. */
  readonly refused: boolean;

  constructor(init: TSyncEntryInit) {
    this.name = init.name;
    this.viewType = init.viewType;
    this.status = init.status;
    this.syncMethod = init.syncMethod;
    this.columnsToAdd = init.columnsToAdd ?? [];
    this.columnsToRename = init.columnsToRename ?? [];
    this.typeChanges = init.typeChanges ?? [];
    this.nullableChanges = init.nullableChanges ?? [];
    this.defaultChanges = init.defaultChanges ?? [];
    this.columnsToDrop = init.columnsToDrop ?? [];
    this.optionChanges = init.optionChanges ?? [];
    this.fkAdded = init.fkAdded ?? [];
    this.fkRemoved = init.fkRemoved ?? [];
    this.fkChanged = init.fkChanged ?? [];
    this.columnsAdded = init.columnsAdded ?? [];
    this.columnsRenamed = init.columnsRenamed ?? [];
    this.columnsDropped = init.columnsDropped ?? [];
    this.recreated = init.recreated ?? false;
    this.errors = init.errors ?? [];
    this.renamedFrom = init.renamedFrom;
    this.pkChange = init.pkChange;
    this.skipped = init.skipped ?? [];
    this.dependsOn = init.dependsOn ?? [];
    this.dropGroup = init.dropGroup;
    this.refused = init.refused ?? false;
  }

  /**
   * The init object this entry was built from — lets callers derive a
   * modified copy (`new SyncEntry({ ...entry.toInit(), status: "error" })`).
   * @since 0.1.128
   */
  toInit(): TSyncEntryInit {
    // Every init key is an own enumerable field of the same name; the
    // `destructive` / `hasChanges` / `hasErrors` accessors live on the prototype.
    return { ...this };
  }

  /**
   * This entry as an `error` entry with `msg` appended to its errors — the
   * shape a DDL failure inside the entry's step reports (the planned work is
   * kept, the status says it did not land).
   * @since 0.1.129
   */
  withError(msg: string): SyncEntry {
    return new SyncEntry({ ...this.toInit(), status: "error", errors: [...this.errors, msg] });
  }

  /**
   * Whether desired work is still pending after this entry — DDL that was
   * not issued because the entry errored or safe mode skipped it (see
   * `skipped`). A pending entry withholds its snapshot and the schema hash,
   * so the next run retries / applies it. External views are advisory and
   * never pending.
   * @since 0.1.128
   */
  get pending(): boolean {
    return (this.status === "error" && this.viewType !== "E") || this.skipped.length > 0;
  }

  /** Whether this entry involves destructive operations (pending work safe mode skipped is not) */
  get destructive(): boolean {
    if (this.status === "drop") {
      // Dropping virtual/external views is not destructive
      return this.viewType !== "V" && this.viewType !== "E";
    }
    return (
      this.columnsToDrop.length > 0 ||
      (this.typeChanges.length > 0 && !this.skipped.includes("recreate")) ||
      this.recreated ||
      // A primary-key rebuild recreates the table on SQLite and rewrites the
      // key everywhere else; a skipped (safe-mode) change is not destructive.
      this.pkChange?.rebuild === true ||
      (this.optionChanges.some((c) => c.destructive) && !this.skipped.includes("table-options"))
    );
  }

  /** Whether this entry represents any change (not in-sync) */
  get hasChanges(): boolean {
    return this.status !== "in-sync" && this.status !== "error";
  }

  /** Whether this entry has errors */
  get hasErrors(): boolean {
    return this.status === "error" || this.errors.length > 0;
  }

  /** Render this entry for display */
  print(mode: "plan" | "result", colors?: TSyncColors): string[] {
    const c = colors ?? noColor;
    return mode === "plan" ? this.printPlan(c) : this.printResult(c);
  }

  // ── Shared helpers ──────────────────────────────────────────────────

  private labelAndPrefix(c: TSyncColors) {
    return {
      label: c.bold(c.underline(this.name)),
      vp: this.viewType ? `${c.dim(`[${this.viewType}]`)} ` : "",
    };
  }

  private printError(c: TSyncColors, label: string, vp: string): string[] {
    const head = this.refused ? `✖ refused: ${vp}${label}` : `✗ ${vp}${label} — error`;
    return [`  ${c.red(head)}`, ...this.errors.map((err) => `      ${c.red(err)}`)];
  }

  /** `! PK (id) → (code) — rebuild (table is empty)` / `— skipped (safe mode)` */
  private printPkChange(c: TSyncColors, mode: "plan" | "result"): string[] {
    const pk = this.pkChange;
    if (!pk) {
      return [];
    }
    const cols = `PK (${pk.from.join(", ")}) → (${pk.to.join(", ")})`;
    if (!pk.rebuild) {
      return [`      ${c.yellow(`! ${cols} — skipped (safe mode)`)}`];
    }
    return mode === "plan"
      ? [`      ${c.red(`! ${cols} — rebuild (table is empty)`)}`]
      : [`      ${c.yellow(`~ ${cols} — rebuilt`)}`];
  }

  /**
   * `! col: t1 → t2 — drop` (plan), or `! type col (t1 → t2) — skipped (safe
   * mode)` in plan and result when the `'drop'` recreate was skipped.
   */
  private printTypeChanges(c: TSyncColors): string[] {
    if (this.skipped.includes("recreate")) {
      return this.typeChanges.map(
        (tc) =>
          `      ${c.yellow(`! type ${tc.column} (${tc.fromType} → ${tc.toType}) — skipped (safe mode)`)}`,
      );
    }
    return this.typeChanges.map((tc) => {
      const action = this.syncMethod ? ` — ${this.syncMethod}` : " — requires migration";
      return `      ${c.red(`! ${tc.column}: ${tc.fromType} → ${tc.toType}${action}`)}`;
    });
  }

  /** `~ col — nullable` / `~ col — default a → b`, `— skipped (safe mode)` when pending. */
  private printNullableDefaults(c: TSyncColors): string[] {
    const suffix = this.skipped.includes("nullable-defaults") ? " — skipped (safe mode)" : "";
    return [
      ...this.nullableChanges.map(
        (nc) =>
          `      ${c.yellow(`~ ${nc.column} — ${nc.toNullable ? "nullable" : "non-nullable"}${suffix}`)}`,
      ),
      ...this.defaultChanges.map(
        (dc) =>
          `      ${c.yellow(`~ ${dc.column} — default ${dc.oldDefault ?? "none"} → ${dc.newDefault ?? "none"}${suffix}`)}`,
      ),
    ];
  }

  /**
   * Plan: `~ option k: a → b`, or `! option k: a → b — requires recreation`
   * for a destructive change. Result: `~ option k: a → b` for an applied
   * change. Both: `! option k: a → b — skipped (safe mode)` when pending.
   */
  private printOptionChanges(c: TSyncColors, mode: "plan" | "result"): string[] {
    const skipped = this.skipped.includes("table-options");
    return this.optionChanges.map((oc) => {
      if (oc.destructive && skipped) {
        return `      ${c.red("!")} ${c.cyan(`option ${oc.key}`)}: ${oc.oldValue} → ${oc.newValue} — skipped (safe mode)`;
      }
      if (mode === "result") {
        return `      ${c.cyan(`~ option ${oc.key}: ${oc.oldValue} → ${oc.newValue}`)}`;
      }
      const tag = oc.destructive ? c.red("!") : c.yellow("~");
      const action = oc.destructive ? " — requires recreation" : "";
      return `      ${tag} ${c.cyan(`option ${oc.key}`)}: ${oc.oldValue} → ${oc.newValue}${action}`;
    });
  }

  /** `· after: a, b` (plan only — the executor already runs in this order). */
  private printDependsOn(c: TSyncColors): string[] {
    if (this.dependsOn.length === 0) {
      return [];
    }
    return [`      ${c.dim(`· after: ${this.dependsOn.join(", ")}`)}`];
  }

  private printDropGroup(c: TSyncColors): string[] {
    const others = this.dropGroup?.filter((n) => n !== this.name) ?? [];
    if (others.length === 0) {
      return [];
    }
    return [`      ${c.dim(`· dropped with: ${others.join(", ")}`)}`];
  }

  // ── Plan printing ───────────────────────────────────────────────────

  private printPlan(c: TSyncColors): string[] {
    const { label, vp } = this.labelAndPrefix(c);

    if (this.status === "error") {
      return this.printError(c, label, vp);
    }

    if (this.status === "drop") {
      const kind = this.viewType ? "drop view" : "drop table";
      return [
        `  ${c.red(`- ${vp}${label} — ${kind}`)}`,
        ...this.printDependsOn(c),
        ...this.printDropGroup(c),
      ];
    }

    if (this.status === "create") {
      return [
        `  ${c.green(`+ ${vp}${label} — create`)}`,
        ...this.columnsToAdd.map(
          (col) =>
            `      ${c.green(`+ ${col.physicalName} (${col.designType})${col.isPrimaryKey ? " PK" : ""}${col.optional ? " nullable" : ""} — add`)}`,
        ),
        ...this.printDependsOn(c),
        "",
      ];
    }

    if (this.status === "alter") {
      const renameInfo = this.renamedFrom
        ? ` ${c.yellow(`(renamed from ${this.renamedFrom})`)}`
        : "";
      return [
        `  ${c.cyan(`~ ${vp}${label} — alter${renameInfo}`)}`,
        ...this.columnsToAdd.map(
          (col) => `      ${c.green(`+ ${col.physicalName} (${col.designType}) — add`)}`,
        ),
        ...this.columnsToRename.map((r) => `      ${c.yellow(`~ ${r.from} → ${r.to} — rename`)}`),
        ...this.printTypeChanges(c),
        ...this.printNullableDefaults(c),
        ...this.printPkChange(c, "plan"),
        ...this.columnsToDrop.map((col) => `      ${c.red(`- ${col} — drop`)}`),
        ...this.printOptionChanges(c, "plan"),
        ...this.fkAdded.map(
          (fk) => `      ${c.green(`+ FK(${fk.fields.join(",")}) → ${fk.targetTable} — add`)}`,
        ),
        ...this.fkRemoved.map(
          (fk) => `      ${c.red(`- FK(${fk.fields.join(",")}) → ${fk.targetTable} — remove`)}`,
        ),
        ...this.fkChanged.map(
          (fk) =>
            `      ${c.yellow(`~ FK(${fk.fields.join(",")}) → ${fk.targetTable} — ${fk.details}`)}`,
        ),
        ...this.printDependsOn(c),
        "",
      ];
    }

    return [this.printInSync(c)];
  }

  // ── Result printing ─────────────────────────────────────────────────

  private printResult(c: TSyncColors): string[] {
    const { label, vp } = this.labelAndPrefix(c);

    if (this.status === "error") {
      return this.printError(c, label, vp);
    }

    if (this.status === "drop") {
      const kind = this.viewType ? "dropped view" : "dropped table";
      return [`  ${c.red(`- ${vp}${label} — ${kind}`)}`, ...this.printDropGroup(c)];
    }

    if (this.status === "create") {
      return [
        `  ${c.green(`+ ${vp}${label} — created`)}`,
        ...this.columnsAdded.map((col) => `      ${c.green(`+ ${col} — added`)}`),
        "",
      ];
    }

    const hasChanges =
      this.columnsAdded.length > 0 ||
      this.columnsRenamed.length > 0 ||
      this.columnsDropped.length > 0 ||
      this.optionChanges.length > 0 ||
      this.pkChange !== undefined ||
      this.skipped.length > 0;

    if (hasChanges || this.recreated || this.renamedFrom) {
      const rlabel = this.recreated ? "recreated" : "altered";
      const renameInfo = this.renamedFrom
        ? ` ${c.yellow(`(renamed from ${this.renamedFrom})`)}`
        : "";
      const color = this.recreated ? (s: string) => c.yellow(s) : (s: string) => c.cyan(s);
      // Result entries carry type / nullable / default changes only when safe
      // mode skipped them — printed as skipped, like the plan.
      return [
        `  ${color(`~ ${vp}${label} — ${rlabel}${renameInfo}`)}`,
        ...this.columnsAdded.map((col) => `      ${c.green(`+ ${col} — added`)}`),
        ...this.columnsRenamed.map((col) => `      ${c.yellow(`~ ${col} — renamed`)}`),
        ...this.printPkChange(c, "result"),
        ...this.printTypeChanges(c),
        ...this.printNullableDefaults(c),
        ...this.columnsDropped.map((col) => `      ${c.red(`- ${col} — dropped`)}`),
        ...this.printOptionChanges(c, "result"),
        "",
      ];
    }

    const lines = [this.printInSync(c)];
    if (this.errors.length > 0) {
      lines.push(...this.errors.map((err) => `    ${c.red(`Error: ${err}`)}`));
    }
    return lines;
  }

  // ── Shared ──────────────────────────────────────────────────────────

  private printInSync(c: TSyncColors): string {
    const prefix = this.viewType ? `${c.dim(`[${this.viewType}]`)} ` : "";
    return `  ${c.green("✓")} ${prefix}${c.bold(this.name)} ${c.dim("— in sync")}`;
  }
}
