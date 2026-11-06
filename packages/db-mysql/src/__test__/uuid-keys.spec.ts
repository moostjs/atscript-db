import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import type { TColumnDiff, TDbFieldMeta, TExistingColumn } from "@atscript/db";
import { computeColumnDiff } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { mysqlIndexPrefix } from "../sql-builder";
import { prepareFixtures, createMockDriver } from "./test-utils";
import type { TMockDriverOptions } from "./test-utils";

// A `@db.default.uuid` string is CHAR(36) (VARCHAR(255) up to 0.1.169), and
// so is every foreign-key column pointing at one. An existing VARCHAR(255)
// column is changed in place by schema sync: MySQL refuses to change a column
// a live foreign key uses, so those constraints are dropped around the MODIFY
// and re-created as they were — also when the MODIFY fails.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/uuid-keys.as");
});

const allTypes = () => [
  fx.UkParent,
  fx.UkChild,
  fx.UkTag,
  fx.UkLink,
  fx.UkNode,
  fx.UkLegacy,
  fx.UkLegacyRef,
];

function tableOf(type: unknown, opts?: TMockDriverOptions) {
  const driver = createMockDriver(opts);
  const space = new DbSpace(() => new MysqlAdapter(driver));
  for (const t of allTypes()) space.getTable(t);
  const table = space.getTable(type as any);
  return { driver, adapter: table.dbAdapter as MysqlAdapter, table };
}

/** `path → mapped type` for every column of `type`. */
function mappedTypes(type: unknown): Record<string, string> {
  const { adapter, table } = tableOf(type);
  return Object.fromEntries(
    table.columnDescriptors.map((f: TDbFieldMeta) => [f.path, adapter.typeMapper(f)]),
  );
}

async function createTableSql(type: unknown): Promise<string> {
  const { driver, table } = tableOf(type);
  await table.dbAdapter.ensureTable();
  return driver.calls.find((c) => c.sql.startsWith("CREATE TABLE"))!.sql;
}

/** The type changes schema sync finds for `type` over live columns of `overrides` (path → live type). */
function typeChanges(type: unknown, overrides: Record<string, string> = {}) {
  const { adapter, table } = tableOf(type);
  const live: TExistingColumn[] = table.columnDescriptors.map((f: TDbFieldMeta) => ({
    name: f.physicalName,
    type: (overrides[f.path] ?? adapter.typeMapper(f)).toUpperCase(),
    notnull: !f.optional,
    pk: f.isPrimaryKey,
  }));
  return computeColumnDiff(table.columnDescriptors, live, (f) => adapter.typeMapper(f))
    .typeChanged.map((c) => `${c.field.path}: ${c.existingType} → ${adapter.typeMapper(c.field)}`)
    .toSorted();
}

describe("MySQL — a @db.default.uuid string is CHAR(36)", () => {
  it("as a primary key, a plain or a unique column; a declared length or another default keeps VARCHAR", () => {
    expect(mappedTypes(fx.UkParent)).toMatchObject({
      id: "CHAR(36)",
      token: "CHAR(36)",
      pairA: "CHAR(36)",
      pairB: "CHAR(36)",
      sized: "VARCHAR(64)",
      status: "VARCHAR(255)",
      label: "TEXT",
    });
  });

  it("@db.mysql.type keeps the earlier VARCHAR(255), and its foreign key follows it", () => {
    expect(mappedTypes(fx.UkLegacy).id).toBe("VARCHAR(255)");
    expect(mappedTypes(fx.UkLegacyRef).legacyId).toBe("VARCHAR(255)");
  });

  it("CREATE TABLE renders CHAR(36) with the UUID() default", async () => {
    const sql = await createTableSql(fx.UkParent);
    expect(sql).toContain("`id` CHAR(36) DEFAULT (UUID()) PRIMARY KEY");
    expect(sql).toContain("`token` CHAR(36) NOT NULL DEFAULT (UUID())");
    expect(sql).toContain("`sized` VARCHAR(64) NOT NULL DEFAULT (UUID())");
  });

  it("foreign-key columns pointing at a uuid key are CHAR(36): plain, composite, junction and self-reference", async () => {
    expect(mappedTypes(fx.UkChild)).toMatchObject({
      parentId: "CHAR(36)",
      pairA: "CHAR(36)",
      pairB: "CHAR(36)",
    });
    expect(mappedTypes(fx.UkLink)).toMatchObject({ parentId: "CHAR(36)", tagId: "CHAR(36)" });
    expect(mappedTypes(fx.UkNode)).toMatchObject({ id: "CHAR(36)", parentId: "CHAR(36)" });

    const child = await createTableSql(fx.UkChild);
    // the foreign-key column does not take the referenced column's default
    expect(child).toContain("`parentId` CHAR(36) NOT NULL,");
    expect(child).toContain(
      "FOREIGN KEY (`pairA`, `pairB`) REFERENCES `uk_parents` (`pairA`, `pairB`)",
    );
    const junction = await createTableSql(fx.UkLink);
    expect(junction).toContain("`parentId` CHAR(36) NOT NULL");
    expect(junction).toContain("`tagId` CHAR(36) NOT NULL");
    expect(await createTableSql(fx.UkNode)).toContain(
      "FOREIGN KEY (`parentId`) REFERENCES `uk_nodes` (`id`)",
    );
  });

  it("CHAR(36) is keyed in full: no key-length prefix", async () => {
    expect(mysqlIndexPrefix("CHAR(36)", 4)).toBeUndefined();
    const { driver, table } = tableOf(fx.UkParent);
    await table.syncIndexes();
    expect(driver.calls.map((c) => c.sql)).toContain(
      "CREATE UNIQUE INDEX `atscript__unique__uk_pair_idx` ON `uk_parents` (`pairA` ASC, `pairB` ASC)",
    );
  });

  it("a synced CHAR(36) column is not altered; an earlier VARCHAR(255) one is, on both sides of a key", () => {
    expect(typeChanges(fx.UkParent)).toEqual([]);
    expect(typeChanges(fx.UkChild)).toEqual([]);
    expect(typeChanges(fx.UkLink)).toEqual([]);
    expect(
      typeChanges(fx.UkParent, {
        id: "varchar(255)",
        token: "varchar(255)",
        pairA: "varchar(255)",
        pairB: "varchar(255)",
        sized: "varchar(64)",
        status: "varchar(255)",
      }),
    ).toEqual([
      "id: VARCHAR(255) → CHAR(36)",
      "pairA: VARCHAR(255) → CHAR(36)",
      "pairB: VARCHAR(255) → CHAR(36)",
      "token: VARCHAR(255) → CHAR(36)",
    ]);
    expect(typeChanges(fx.UkChild, { parentId: "varchar(255)", pairA: "varchar(255)" })).toEqual([
      "pairA: VARCHAR(255) → CHAR(36)",
      "parentId: VARCHAR(255) → CHAR(36)",
    ]);
    expect(typeChanges(fx.UkLegacy, { id: "varchar(255)" })).toEqual([]);
  });
});

// ── Foreign keys around the in-place type change ────────────────────────────

/** An INFORMATION_SCHEMA row of {@link MysqlAdapter}'s live foreign-key probe. */
function fkRow(
  table: string,
  name: string,
  column: string,
  refTable: string,
  refColumn: string,
  rules: { del?: string; upd?: string; own?: boolean; ref?: boolean } = {},
) {
  return {
    TABLE_SCHEMA: "app",
    TABLE_NAME: table,
    CONSTRAINT_NAME: name,
    COLUMN_NAME: column,
    REFERENCED_TABLE_SCHEMA: "app",
    REFERENCED_TABLE_NAME: refTable,
    REFERENCED_COLUMN_NAME: refColumn,
    DELETE_RULE: rules.del ?? "NO ACTION",
    UPDATE_RULE: rules.upd ?? "NO ACTION",
    IS_OWN: rules.own ? 1 : 0,
    IS_REF: (rules.ref ?? !rules.own) ? 1 : 0,
  };
}

const parentFks = [
  fkRow("uk_children", "uk_children_ibfk_1", "parentId", "uk_parents", "id", { del: "CASCADE" }),
  fkRow("uk_children", "uk_children_ibfk_2", "pairA", "uk_parents", "pairA"),
  fkRow("uk_children", "uk_children_ibfk_2", "pairB", "uk_parents", "pairB"),
  fkRow("uk_links", "uk_links_ibfk_1", "parentId", "uk_parents", "id", { upd: "RESTRICT" }),
];

const COLLATION = "utf8mb4_unicode_ci";

/** A live INFORMATION_SCHEMA.COLUMNS row of the compatibility probe. */
const liveColumn = (
  table: string,
  column: string,
  type = "varchar(255)",
  collation = COLLATION,
) => ({
  TABLE_SCHEMA: "app",
  TABLE_NAME: table,
  COLUMN_NAME: column,
  COLUMN_TYPE: type,
  COLLATION_NAME: collation,
});

/** The other sides of the fixtures' foreign keys, as an earlier release created them. */
const earlierColumns = [
  liveColumn("uk_children", "parentId"),
  liveColumn("uk_children", "pairA"),
  liveColumn("uk_children", "pairB"),
  liveColumn("uk_links", "parentId"),
  liveColumn("uk_parents", "id"),
];

/** Mock answers: the foreign keys, the other sides' live columns, the table collation. */
function liveFks(fks: unknown[], columns: unknown[] = earlierColumns): TMockDriverOptions {
  return {
    all: [
      ["REFERENTIAL_CONSTRAINTS", fks],
      ["COLUMN_TYPE, COLLATION_NAME", columns],
    ],
    get: [["TABLE_COLLATION FROM", { TABLE_COLLATION: COLLATION }]],
  };
}

function diffOf(
  table: { fieldDescriptors: readonly TDbFieldMeta[] },
  change: Partial<Record<"typeChanged" | "nullableChanged", string[]>>,
  existingType = "VARCHAR(255)",
): TColumnDiff {
  const field = (path: string) => table.fieldDescriptors.find((f) => f.path === path)!;
  return {
    added: [],
    removed: [],
    renamed: [],
    typeChanged: (change.typeChanged ?? []).map((p) => ({ field: field(p), existingType })),
    nullableChanged: (change.nullableChanged ?? []).map((p) => ({
      field: field(p),
      wasNullable: false,
    })),
    defaultChanged: [],
    conflicts: [],
  };
}

async function syncColumnsOf(
  type: unknown,
  change: Parameters<typeof diffOf>[1],
  opts: TMockDriverOptions = {},
  existingType?: string,
) {
  const { driver, adapter, table } = tableOf(type, opts);
  const outcome = await adapter.syncColumns(diffOf(table, change, existingType)).then(
    () => undefined,
    (error: Error) => error,
  );
  const execs = driver.calls.filter((c) => c.method === "exec");
  return {
    outcome,
    ddl: execs.filter((c) => !c.sql.startsWith("SET")).map((c) => c.sql),
    all: execs.map((c) => c.sql),
    probes: driver.calls.filter((c) => c.method === "all"),
    via: new Set(execs.map((c) => c.via)),
  };
}

const ADD_CHILDREN =
  "ALTER TABLE `app`.`uk_children` ADD CONSTRAINT `uk_children_ibfk_1` FOREIGN KEY (`parentId`) REFERENCES `app`.`uk_parents` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION, " +
  "ADD CONSTRAINT `uk_children_ibfk_2` FOREIGN KEY (`pairA`, `pairB`) REFERENCES `app`.`uk_parents` (`pairA`, `pairB`) ON DELETE NO ACTION ON UPDATE NO ACTION";
const ADD_CHILD_1 =
  "ALTER TABLE `app`.`uk_children` ADD CONSTRAINT `uk_children_ibfk_1` FOREIGN KEY (`parentId`) REFERENCES `app`.`uk_parents` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION";
const ADD_LINKS =
  "ALTER TABLE `app`.`uk_links` ADD CONSTRAINT `uk_links_ibfk_1` FOREIGN KEY (`parentId`) REFERENCES `app`.`uk_parents` (`id`) ON DELETE NO ACTION ON UPDATE RESTRICT";

describe("MySQL — foreign keys over a column whose type changes", () => {
  it("drops the inbound foreign keys before MODIFY and re-creates them as they were after, one ALTER per table", async () => {
    const { outcome, ddl } = await syncColumnsOf(
      fx.UkParent,
      { typeChanged: ["id", "pairA", "pairB"] },
      liveFks(parentFks),
    );
    expect(outcome).toBeUndefined();
    expect(ddl).toEqual([
      "ALTER TABLE `app`.`uk_children` DROP FOREIGN KEY `uk_children_ibfk_1`",
      "ALTER TABLE `app`.`uk_children` DROP FOREIGN KEY `uk_children_ibfk_2`",
      "ALTER TABLE `app`.`uk_links` DROP FOREIGN KEY `uk_links_ibfk_1`",
      "ALTER TABLE `uk_parents` MODIFY COLUMN `id` CHAR(36) NOT NULL DEFAULT (UUID())",
      "ALTER TABLE `uk_parents` MODIFY COLUMN `pairA` CHAR(36) NOT NULL DEFAULT (UUID())",
      "ALTER TABLE `uk_parents` MODIFY COLUMN `pairB` CHAR(36) NOT NULL DEFAULT (UUID())",
      ADD_CHILDREN,
      ADD_LINKS,
    ]);
  });

  it("re-creates them with foreign_key_checks off on the same connection, and restores the setting", async () => {
    const { all, via } = await syncColumnsOf(
      fx.UkParent,
      { typeChanged: ["id"] },
      liveFks(parentFks),
    );
    const off = all.indexOf(
      "SET @atscript_fk_checks = @@SESSION.foreign_key_checks, SESSION foreign_key_checks = 0",
    );
    const on = all.indexOf("SET SESSION foreign_key_checks = @atscript_fk_checks");
    const modify = all.findIndex((d) => d.includes("MODIFY COLUMN `id`"));
    const adds = all.flatMap((d, i) => (d.includes("ADD CONSTRAINT") ? [i] : []));
    expect(off).toBeGreaterThan(modify);
    expect(adds.every((i) => i > off && i < on)).toBe(true);
    expect(adds).toHaveLength(2);
    // every statement on the one held connection
    expect([...via]).toEqual(["conn"]);
  });

  it("lifts only the constraints over a retyped column — a composite one when any of its columns is", async () => {
    const { ddl } = await syncColumnsOf(
      fx.UkParent,
      { typeChanged: ["pairB"] },
      liveFks(parentFks),
    );
    expect(ddl.filter((d) => /FOREIGN KEY `|ADD CONSTRAINT/.test(d))).toEqual([
      "ALTER TABLE `app`.`uk_children` DROP FOREIGN KEY `uk_children_ibfk_2`",
      expect.stringContaining("ADD CONSTRAINT `uk_children_ibfk_2` FOREIGN KEY (`pairA`, `pairB`)"),
    ]);
  });

  it("lifts a table's own foreign key over its retyped column, a self-reference once", async () => {
    const ownRule = { del: "CASCADE", own: true, ref: false };
    const ownRows = [
      fkRow("uk_children", "uk_children_ibfk_1", "parentId", "uk_parents", "id", ownRule),
      fkRow("uk_children", "uk_children_ibfk_2", "pairA", "uk_parents", "pairA", { own: true }),
      fkRow("uk_children", "uk_children_ibfk_2", "pairB", "uk_parents", "pairB", { own: true }),
    ];
    const own = await syncColumnsOf(fx.UkChild, { typeChanged: ["parentId"] }, liveFks(ownRows));
    expect(own.ddl).toEqual([
      "ALTER TABLE `app`.`uk_children` DROP FOREIGN KEY `uk_children_ibfk_1`",
      "ALTER TABLE `uk_children` MODIFY COLUMN `parentId` CHAR(36) NOT NULL",
      ADD_CHILD_1,
    ]);

    const self = fkRow("uk_nodes", "uk_nodes_ibfk_1", "parentId", "uk_nodes", "id", {
      own: true,
      ref: true,
    });
    const tree = await syncColumnsOf(
      fx.UkNode,
      { typeChanged: ["id", "parentId"] },
      liveFks([self]),
    );
    expect(tree.ddl).toEqual([
      "ALTER TABLE `app`.`uk_nodes` DROP FOREIGN KEY `uk_nodes_ibfk_1`",
      "ALTER TABLE `uk_nodes` MODIFY COLUMN `id` CHAR(36) NOT NULL DEFAULT (UUID())",
      "ALTER TABLE `uk_nodes` MODIFY COLUMN `parentId` CHAR(36) NULL",
      "ALTER TABLE `app`.`uk_nodes` ADD CONSTRAINT `uk_nodes_ibfk_1` FOREIGN KEY (`parentId`) REFERENCES `app`.`uk_nodes` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION",
    ]);
  });

  describe("nothing is lifted when a constraint would not fit the new type", () => {
    const refused = Object.assign(
      new Error("Cannot change column 'id': used in a foreign key constraint"),
      { errno: 1833 },
    );

    it("an integer key widened while a referencing column outside the run stays INT", async () => {
      const fk = fkRow("ext_orders", "ext_orders_ibfk_1", "counterId", "uk_counters", "id");
      const { outcome, ddl } = await syncColumnsOf(
        fx.UkCounter,
        { typeChanged: ["id"] },
        {
          ...liveFks([fk], [liveColumn("ext_orders", "counterId", "int", null as any)]),
          execError: (sql) => (sql.includes("MODIFY COLUMN") ? refused : undefined),
        },
        "INT",
      );
      // MySQL refuses the MODIFY, as without lifting; the constraint was never dropped
      expect(outcome).toBe(refused);
      expect(ddl).toEqual(["ALTER TABLE `uk_counters` MODIFY COLUMN `id` BIGINT NOT NULL"]);
    });

    it("a string key whose referencing column has another collation", async () => {
      const columns = [
        ...earlierColumns.filter((c) => c.TABLE_NAME !== "uk_links"),
        liveColumn("uk_links", "parentId", "varchar(255)", "utf8mb4_bin"),
      ];
      const { ddl } = await syncColumnsOf(
        fx.UkParent,
        { typeChanged: ["id"] },
        liveFks(parentFks, columns),
      );
      expect(ddl.some((d) => d.includes("FOREIGN KEY `") || d.includes("ADD CONSTRAINT"))).toBe(
        false,
      );
      expect(ddl).toEqual([
        "ALTER TABLE `uk_parents` MODIFY COLUMN `id` CHAR(36) NOT NULL DEFAULT (UUID())",
      ]);
    });

    it("still lifts a VARCHAR(255) referencing column for a CHAR(36) key (the uuid upgrade)", async () => {
      const { ddl } = await syncColumnsOf(fx.UkParent, { typeChanged: ["id"] }, liveFks(parentFks));
      expect(ddl[0]).toBe("ALTER TABLE `app`.`uk_children` DROP FOREIGN KEY `uk_children_ibfk_1`");
    });
  });

  it("a MODIFY failing after another succeeded re-creates the foreign keys and reports the MODIFY's error", async () => {
    const tooLong = Object.assign(new Error("Data too long for column 'pairA' at row 1"), {
      errno: 1406,
    });
    const { outcome, ddl } = await syncColumnsOf(
      fx.UkParent,
      { typeChanged: ["id", "pairA", "pairB"] },
      {
        ...liveFks(parentFks),
        execError: (sql) => (sql.includes("MODIFY COLUMN `pairA`") ? tooLong : undefined),
      },
    );
    expect(outcome).toBe(tooLong);
    expect(ddl.slice(3)).toEqual([
      "ALTER TABLE `uk_parents` MODIFY COLUMN `id` CHAR(36) NOT NULL DEFAULT (UUID())",
      "ALTER TABLE `uk_parents` MODIFY COLUMN `pairA` CHAR(36) NOT NULL DEFAULT (UUID())",
      ADD_CHILDREN,
      ADD_LINKS,
    ]);
  });

  it("a constraint that cannot be re-created is named with its DDL; the others are re-created", async () => {
    const refused = new Error("Referencing column and referenced column are incompatible");
    const { outcome, ddl, all } = await syncColumnsOf(
      fx.UkParent,
      { typeChanged: ["id"] },
      {
        ...liveFks(parentFks),
        execError: (sql) =>
          sql.includes("ADD CONSTRAINT `uk_children_ibfk_1`") ? refused : undefined,
      },
    );
    expect(outcome?.message).toBe(
      `Foreign keys not restored after the type change: \`uk_children_ibfk_1\` on \`app\`.\`uk_children\` (re-create it with: ${ADD_CHILD_1})`,
    );
    expect(ddl.at(-1)).toBe(ADD_LINKS);
    // foreign_key_checks is restored after the failure too
    expect(all.slice(-2)).toEqual([
      "SET SESSION foreign_key_checks = @atscript_fk_checks",
      "SET SESSION sql_mode = @atscript_sql_mode",
    ]);
  });

  it("a grouped re-create that fails is retried constraint by constraint", async () => {
    const refused = new Error("Referencing column and referenced column are incompatible");
    const { outcome, ddl } = await syncColumnsOf(
      fx.UkParent,
      { typeChanged: ["id", "pairA", "pairB"] },
      {
        ...liveFks(parentFks),
        execError: (sql) =>
          sql.includes("ADD CONSTRAINT `uk_children_ibfk_2`") ? refused : undefined,
      },
    );
    expect(ddl.filter((d) => d.includes("ADD CONSTRAINT"))).toEqual([
      ADD_CHILDREN,
      ADD_CHILD_1,
      expect.stringContaining("ADD CONSTRAINT `uk_children_ibfk_2`"),
      ADD_LINKS,
    ]);
    expect(outcome?.message).toMatch(/^Foreign keys not restored .*`uk_children_ibfk_2`/);
    expect(outcome?.message).not.toContain("`uk_children_ibfk_1` on");
  });

  it("a failed MODIFY and a lost constraint: the MODIFY's error first, then the constraint with its DDL", async () => {
    const tooLong = new Error("Data too long for column 'id' at row 1");
    const refused = new Error("incompatible");
    const { outcome } = await syncColumnsOf(
      fx.UkParent,
      { typeChanged: ["id"] },
      {
        ...liveFks(parentFks),
        execError: (sql) =>
          sql.includes("MODIFY COLUMN `id`")
            ? tooLong
            : sql.includes("ADD CONSTRAINT `uk_links_ibfk_1`")
              ? refused
              : undefined,
      },
    );
    expect(outcome?.message).toBe(
      `Data too long for column 'id' at row 1 — and foreign keys not restored: \`uk_links_ibfk_1\` on \`app\`.\`uk_links\` (re-create it with: ${ADD_LINKS})`,
    );
    expect(outcome?.cause).toBe(tooLong);
  });

  it("no type change: no foreign-key probe, no constraint touched", async () => {
    const { ddl, probes } = await syncColumnsOf(
      fx.UkChild,
      { nullableChanged: ["note"] },
      liveFks(parentFks),
    );
    expect(probes.some((c) => c.sql.includes("REFERENTIAL_CONSTRAINTS"))).toBe(false);
    expect(ddl.some((d) => d.includes("FOREIGN KEY"))).toBe(false);
  });

  it("the probe reads foreign-key constraints only (a same-named UNIQUE constraint cannot join one)", async () => {
    const { probes } = await syncColumnsOf(
      fx.UkParent,
      { typeChanged: ["id"] },
      liveFks(parentFks),
    );
    expect(probes.find((c) => c.sql.includes("REFERENTIAL_CONSTRAINTS"))?.sql).toContain(
      "k.REFERENCED_TABLE_NAME IS NOT NULL",
    );
  });
});
