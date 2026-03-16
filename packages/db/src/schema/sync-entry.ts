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
  }

  /** Whether this entry involves destructive operations */
  get destructive(): boolean {
    if (this.status === "drop") {
      // Dropping virtual/external views is not destructive
      return this.viewType !== "V" && this.viewType !== "E";
    }
    return (
      this.columnsToDrop.length > 0 ||
      this.typeChanges.length > 0 ||
      this.recreated ||
      this.optionChanges.some((c) => c.destructive)
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
    return [
      `  ${c.red(`✗ ${vp}${label} — error`)}`,
      ...this.errors.map((err) => `      ${c.red(err)}`),
    ];
  }

  // ── Plan printing ───────────────────────────────────────────────────

  private printPlan(c: TSyncColors): string[] {
    const { label, vp } = this.labelAndPrefix(c);

    if (this.status === "error") {
      return this.printError(c, label, vp);
    }

    if (this.status === "drop") {
      const kind = this.viewType ? "drop view" : "drop table";
      return [`  ${c.red(`- ${vp}${label} — ${kind}`)}`];
    }

    if (this.status === "create") {
      return [
        `  ${c.green(`+ ${vp}${label} — create`)}`,
        ...this.columnsToAdd.map(
          (col) =>
            `      ${c.green(`+ ${col.physicalName} (${col.designType})${col.isPrimaryKey ? " PK" : ""}${col.optional ? " nullable" : ""} — add`)}`,
        ),
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
        ...this.typeChanges.map((tc) => {
          const action = this.syncMethod ? ` — ${this.syncMethod}` : " — requires migration";
          return `      ${c.red(`! ${tc.column}: ${tc.fromType} → ${tc.toType}${action}`)}`;
        }),
        ...this.nullableChanges.map(
          (nc) =>
            `      ${c.yellow(`~ ${nc.column} — ${nc.toNullable ? "nullable" : "non-nullable"}`)}`,
        ),
        ...this.defaultChanges.map(
          (dc) =>
            `      ${c.yellow(`~ ${dc.column} — default ${dc.oldDefault ?? "none"} → ${dc.newDefault ?? "none"}`)}`,
        ),
        ...this.columnsToDrop.map((col) => `      ${c.red(`- ${col} — drop`)}`),
        ...this.optionChanges.map((oc) => {
          const tag = oc.destructive ? c.red("!") : c.yellow("~");
          const action = oc.destructive ? " — requires recreation" : "";
          return `      ${tag} ${c.cyan(`option ${oc.key}`)}: ${oc.oldValue} → ${oc.newValue}${action}`;
        }),
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
      return [`  ${c.red(`- ${vp}${label} — ${kind}`)}`];
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
      this.optionChanges.length > 0;

    if (hasChanges || this.recreated || this.renamedFrom) {
      const rlabel = this.recreated ? "recreated" : "altered";
      const renameInfo = this.renamedFrom
        ? ` ${c.yellow(`(renamed from ${this.renamedFrom})`)}`
        : "";
      const color = this.recreated ? (s: string) => c.yellow(s) : (s: string) => c.cyan(s);
      return [
        `  ${color(`~ ${vp}${label} — ${rlabel}${renameInfo}`)}`,
        ...this.columnsAdded.map((col) => `      ${c.green(`+ ${col} — added`)}`),
        ...this.columnsRenamed.map((col) => `      ${c.yellow(`~ ${col} — renamed`)}`),
        ...this.columnsDropped.map((col) => `      ${c.red(`- ${col} — dropped`)}`),
        ...this.optionChanges.map(
          (oc) => `      ${c.cyan(`~ option ${oc.key}: ${oc.oldValue} → ${oc.newValue}`)}`,
        ),
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
