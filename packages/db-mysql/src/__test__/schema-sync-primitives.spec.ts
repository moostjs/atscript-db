import { describe, it, expect, beforeAll } from "vite-plus/test";
import { AtscriptDbTable, AtscriptDbView, DbSpace } from "@atscript/db";
import type { TColumnDiff, TDbFieldMeta } from "@atscript/db";

import { MysqlAdapter } from "../mysql-adapter";

import { createMockDriver as createDriver, prepareFixtures, type CapturedCall } from "./test-utils";

function diff(partial: Partial<TColumnDiff>): TColumnDiff {
  return {
    added: [],
    removed: [],
    renamed: [],
    typeChanged: [],
    nullableChanged: [],
    defaultChanged: [],
    conflicts: [],
    ...partial,
  };
}

let fx: Record<string, any>;
let CycleA: any;

function pick(table: any, path: string): TDbFieldMeta {
  const f = table.fieldDescriptors.find((d: TDbFieldMeta) => d.path === path);
  if (!f) throw new Error(`no field ${path}`);
  return f;
}

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/sync-preflight.as");
  CycleA = (await import("./fixtures/pf-cycle-a.as")).PfCycleA;
});

// ── Column introspection ───────────────────────────────────────────────────

describe("MysqlAdapter.getExistingColumns — primary key source", () => {
  // As the single COLUMNS ⟕ KEY_COLUMN_USAGE (PRIMARY) query returns them:
  // `id` carries COLUMN_KEY = 'PRI' but is NOT in the PRIMARY constraint.
  const columns = [
    {
      COLUMN_NAME: "id",
      COLUMN_TYPE: "bigint",
      IS_NULLABLE: "NO",
      COLUMN_DEFAULT: null,
      IS_PK: 0,
    },
    {
      COLUMN_NAME: "code",
      COLUMN_TYPE: "varchar(255)",
      IS_NULLABLE: "NO",
      COLUMN_DEFAULT: null,
      IS_PK: 1,
    },
  ];

  it("takes pk from the PRIMARY constraint joined in from KEY_COLUMN_USAGE (one query)", async () => {
    const driver = createDriver({ all: [["INFORMATION_SCHEMA.COLUMNS", columns]] });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.PfTokenV2, adapter);
    const cols = await adapter.getExistingColumns();
    expect(cols.map((c) => [c.name, c.pk])).toEqual([
      ["id", false],
      ["code", true],
    ]);
    expect(driver.calls).toHaveLength(1);
    const sql = driver.calls[0].sql;
    expect(sql).toContain("LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE");
    expect(sql).toContain("CONSTRAINT_NAME = 'PRIMARY'");
    expect(sql).not.toContain("COLUMN_KEY");
  });

  it("reports no key on a table without a PRIMARY constraint (IS_PK null)", async () => {
    const keyless = columns.map((c) => Object.assign({}, c, { IS_PK: null }));
    const driver = createDriver({ all: [["INFORMATION_SCHEMA.COLUMNS", keyless]] });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.PfTokenV1, adapter);
    const cols = await adapter.getExistingColumns();
    expect(cols.every((c) => !c.pk)).toBe(true);
  });
});

// ── rebuildPrimaryKey ─────────────────────────────────────────────────────

describe("MysqlAdapter.rebuildPrimaryKey", () => {
  it("emits one ALTER: MODIFY new key NOT NULL, MODIFY demoted AUTO_INCREMENT column, DROP + ADD PRIMARY KEY", async () => {
    const driver = createDriver({
      all: [
        [
          "INFORMATION_SCHEMA.COLUMNS",
          [{ COLUMN_NAME: "id", COLUMN_TYPE: "bigint", EXTRA: "auto_increment" }],
        ],
      ],
    });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.PfTokenV2, adapter);
    await adapter.rebuildPrimaryKey({ from: ["id"], to: ["code"] });
    const alters = driver.calls.filter((c) => c.sql.startsWith("ALTER TABLE"));
    expect(alters).toHaveLength(1);
    expect(alters[0].sql).toBe(
      "ALTER TABLE `pf_tokens` MODIFY COLUMN `code` VARCHAR(255) NOT NULL, MODIFY COLUMN `id` DOUBLE NOT NULL, DROP PRIMARY KEY, ADD PRIMARY KEY (`code`)",
    );
  });

  it("skips the MODIFY of the old key column when it has no AUTO_INCREMENT", async () => {
    const driver = createDriver({
      all: [
        ["INFORMATION_SCHEMA.COLUMNS", [{ COLUMN_NAME: "id", COLUMN_TYPE: "bigint", EXTRA: "" }]],
      ],
    });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.PfTokenV2, adapter);
    await adapter.rebuildPrimaryKey({ from: ["id"], to: ["code"] });
    expect(driver.calls.find((c) => c.sql.startsWith("ALTER TABLE"))!.sql).toBe(
      "ALTER TABLE `pf_tokens` MODIFY COLUMN `code` VARCHAR(255) NOT NULL, DROP PRIMARY KEY, ADD PRIMARY KEY (`code`)",
    );
  });

  it("re-declares a demoted AUTO_INCREMENT column that left the model from its live type", async () => {
    const driver = createDriver({
      all: [
        [
          "INFORMATION_SCHEMA.COLUMNS",
          [{ COLUMN_NAME: "id", COLUMN_TYPE: "bigint unsigned", EXTRA: "auto_increment" }],
        ],
      ],
    });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.PfTokenDropOld, adapter);
    await adapter.rebuildPrimaryKey({ from: ["id"], to: ["code"] });
    expect(driver.calls.find((c) => c.sql.startsWith("ALTER TABLE"))!.sql).toBe(
      "ALTER TABLE `pf_tokens` MODIFY COLUMN `code` VARCHAR(255) NOT NULL, MODIFY COLUMN `id` BIGINT UNSIGNED NOT NULL, DROP PRIMARY KEY, ADD PRIMARY KEY (`code`)",
    );
  });

  it("composite: ADD PRIMARY KEY lists every new column; a table gaining its first key has no DROP", async () => {
    const driver = createDriver();
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.PfTokenV2, adapter);
    await adapter.rebuildPrimaryKey({ from: [], to: ["code", "label"] });
    expect(driver.calls.find((c) => c.sql.startsWith("ALTER TABLE"))!.sql).toBe(
      "ALTER TABLE `pf_tokens` MODIFY COLUMN `code` VARCHAR(255) NOT NULL, MODIFY COLUMN `label` TEXT NOT NULL, ADD PRIMARY KEY (`code`, `label`)",
    );
  });
});

// ── Other primitives ──────────────────────────────────────────────────────

describe("MysqlAdapter — sync primitives", () => {
  it("hasRows uses SELECT EXISTS on the own or a named table", async () => {
    const driver = createDriver({ get: [["FROM `pf_tokens`", { present: 1 }]] });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.PfTokenV1, adapter);
    expect(await adapter.hasRows()).toBe(true);
    expect(driver.calls[0].sql).toBe("SELECT EXISTS(SELECT 1 FROM `pf_tokens`) AS present");
    expect(await adapter.hasRows("old_tokens")).toBe(false);
    expect(driver.calls[1].sql).toBe("SELECT EXISTS(SELECT 1 FROM `old_tokens`) AS present");
  });

  it("getExistingTableOptions introspects the own or a named table — same query, the name is the parameter", async () => {
    const driver = createDriver({
      get: [
        ["INFORMATION_SCHEMA.TABLES", { ENGINE: "InnoDB", TABLE_COLLATION: "utf8mb4_unicode_ci" }],
      ],
    });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.PfTokenV1, adapter);
    const options = [
      { key: "engine", value: "InnoDB" },
      { key: "charset", value: "utf8mb4" },
      { key: "collation", value: "utf8mb4_unicode_ci" },
    ];
    expect(await adapter.getExistingTableOptions()).toEqual(options);
    expect(driver.calls[0].params).toEqual(["pf_tokens", null]);
    expect(await adapter.getExistingTableOptions("old_tokens")).toEqual(options);
    expect(driver.calls[1].params).toEqual(["old_tokens", null]);
    expect(driver.calls[1].sql).toBe(driver.calls[0].sql);
  });

  it("getReferencingForeignKeys queries by REFERENCED_TABLE_NAME and groups composite constraints", async () => {
    const driver = createDriver({
      all: [
        [
          "REFERENCED_TABLE_NAME = ?",
          [
            {
              TABLE_NAME: "children",
              CONSTRAINT_NAME: "fk1",
              COLUMN_NAME: "pa",
              REFERENCED_COLUMN_NAME: "a",
            },
            {
              TABLE_NAME: "children",
              CONSTRAINT_NAME: "fk1",
              COLUMN_NAME: "pb",
              REFERENCED_COLUMN_NAME: "b",
            },
            {
              TABLE_NAME: "logs",
              CONSTRAINT_NAME: "fk2",
              COLUMN_NAME: "parentId",
              REFERENCED_COLUMN_NAME: "id",
            },
          ],
        ],
      ],
    });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.PfParent, adapter);
    expect(await adapter.getReferencingForeignKeys("pf_parents")).toEqual([
      { table: "children", fields: ["pa", "pb"], targetFields: ["a", "b"] },
      { table: "logs", fields: ["parentId"], targetFields: ["id"] },
    ]);
    expect(driver.calls[0].params?.[0]).toBe("pf_parents");
    expect(driver.calls[0].sql).toContain("REFERENCED_TABLE_SCHEMA = COALESCE(?, DATABASE())");
  });

  it("getObjectKind maps INFORMATION_SCHEMA.TABLES.TABLE_TYPE", async () => {
    const driver = createDriver({
      get: [["'t'", { TABLE_TYPE: "BASE TABLE" }]],
    });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.PfParent, adapter);
    driver.get = async (sql: string, params?: unknown[]) => {
      driver.calls.push({ via: "pool", method: "get", sql, params });
      const map: Record<string, unknown> = {
        t: { TABLE_TYPE: "BASE TABLE" },
        v: { TABLE_TYPE: "VIEW" },
      };
      return (map[String(params?.[0])] ?? null) as any;
    };
    expect(await adapter.getObjectKind("t")).toBe("table");
    expect(await adapter.getObjectKind("v")).toBe("view");
    expect(await adapter.getObjectKind("none")).toBeUndefined();
    expect(driver.calls[0].sql).toContain("INFORMATION_SCHEMA.TABLES");
  });

  it("recreateTable runs the FOREIGN_KEY_CHECKS toggle and every DDL on ONE dedicated connection", async () => {
    const driver = createDriver({
      all: [
        [
          "INFORMATION_SCHEMA.COLUMNS",
          [
            {
              COLUMN_NAME: "id",
              COLUMN_TYPE: "bigint",
              IS_NULLABLE: "NO",
              COLUMN_DEFAULT: null,
              IS_PK: 1,
            },
          ],
        ],
      ],
    });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.PfTokenV1, adapter);
    await adapter.recreateTable();
    const ddl = driver.calls.filter((c) => c.method === "exec");
    expect(ddl.map((c) => c.via)).toEqual(ddl.map(() => "conn"));
    expect(ddl[0].sql).toBe("SET FOREIGN_KEY_CHECKS = 0");
    expect(ddl.at(-1)!.sql).toBe("SET FOREIGN_KEY_CHECKS = 1");
    expect(ddl.some((c) => c.sql.startsWith("DROP TABLE IF EXISTS `pf_tokens`"))).toBe(true);
    expect(ddl.some((c) => c.sql.startsWith("RENAME TABLE"))).toBe(true);
    expect(driver.releaseCount()).toBe(1);
  });

  it("ensureTable omits inline FKs to deferred cycle members", async () => {
    const driver = createDriver();
    const space = new DbSpace(() => new MysqlAdapter(driver));
    const adapter = space.getAdapter(CycleA);
    await adapter.ensureTable({ deferForeignKeysTo: new Set(["pf_cycle_a", "pf_cycle_b"]) });
    const create = driver.calls.find((c) => c.sql.startsWith("CREATE TABLE"))!.sql;
    expect(create).not.toContain("FOREIGN KEY");
    driver.calls.length = 0;
    await adapter.ensureTable();
    expect(driver.calls.find((c) => c.sql.startsWith("CREATE TABLE"))!.sql).toContain(
      "FOREIGN KEY (`bId`) REFERENCES `pf_cycle_b` (`id`)",
    );
  });
});

// ── Views ─────────────────────────────────────────────────────────────────

describe("MysqlAdapter — views", () => {
  it("creates a view for a duck-typed readable (structural isView) and excludes @db.ignore fields", async () => {
    const real = new DbSpace(() => new MysqlAdapter(createDriver())).getView(
      fx.PfTokenList,
    ) as AtscriptDbView;
    const duck = {
      isView: true,
      isExternal: false,
      tableName: real.tableName,
      schema: undefined,
      viewPlan: real.viewPlan,
      fieldDescriptors: real.fieldDescriptors,
      getViewColumnMappings: () => real.getViewColumnMappings(),
      resolveFieldRef: (ref: any, qi?: any) => real.resolveFieldRef(ref, qi),
    };
    expect(duck instanceof AtscriptDbView).toBe(false);
    const driver = createDriver();
    const adapter = new MysqlAdapter(driver);
    adapter.registerReadable(duck as any);
    await adapter.ensureTable();
    const ddl = driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
    expect(ddl).toHaveLength(1);
    expect(ddl[0]).toMatch(/^CREATE (OR REPLACE )?VIEW/);
    expect(ddl[0]).not.toContain("CREATE TABLE");
    expect(ddl[0]).not.toContain("computed");
    expect(ddl[0]).toContain("`label`");
  });
});

// ── syncColumns through the shared column builder ────────────────────────

describe("MysqlAdapter.syncColumns — one definition renderer", () => {
  function setup() {
    const driver = createDriver();
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(fx.PfStamped, adapter);
    const ddl = () => driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
    return { driver, adapter, table, ddl };
  }

  it("never produces DEFAULT NULL — a default removal on a required column MODIFYs without DEFAULT", async () => {
    const { adapter, table, ddl } = setup();
    const status = { ...pick(table, "status"), defaultValue: undefined };
    await adapter.syncColumns(diff({ defaultChanged: [{ field: status, oldDefault: "draft" }] }));
    expect(ddl()).toEqual([
      "ALTER TABLE `pf_stamped` MODIFY COLUMN `status` TEXT NOT NULL COLLATE utf8mb4_general_ci",
    ]);
  });

  it("optional column default removal MODIFYs with NULL, never DEFAULT NULL", async () => {
    const { adapter, table, ddl } = setup();
    await adapter.syncColumns(
      diff({ defaultChanged: [{ field: pick(table, "note"), oldDefault: "" }] }),
    );
    expect(ddl()).toEqual(["ALTER TABLE `pf_stamped` MODIFY COLUMN `note` TEXT NULL"]);
    expect(ddl().join("\n")).not.toContain("DEFAULT NULL");
  });

  it("type / nullable changes keep DEFAULT, COLLATE and ON UPDATE on the MODIFY", async () => {
    const { adapter, table, ddl } = setup();
    await adapter.syncColumns(
      diff({
        typeChanged: [{ field: pick(table, "status"), existingType: "TEXT" }],
        nullableChanged: [{ field: pick(table, "updatedAt"), wasNullable: true }],
      }),
    );
    expect(ddl()).toEqual([
      "UPDATE `pf_stamped` SET `updatedAt` = CURRENT_TIMESTAMP WHERE `updatedAt` IS NULL",
      "ALTER TABLE `pf_stamped` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'draft' COLLATE utf8mb4_general_ci",
      "ALTER TABLE `pf_stamped` MODIFY COLUMN `updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
    ]);
  });

  it("three changes on one column collapse into ONE MODIFY", async () => {
    const { adapter, table, ddl } = setup();
    const status = pick(table, "status");
    await adapter.syncColumns(
      diff({
        typeChanged: [{ field: status, existingType: "TEXT" }],
        nullableChanged: [{ field: status, wasNullable: true }],
        defaultChanged: [{ field: status, oldDefault: "x", newDefault: "draft" }],
      }),
    );
    const modifies = ddl().filter((s) => s.includes("MODIFY COLUMN"));
    expect(modifies).toHaveLength(1);
    expect(modifies[0]).toContain(
      "`status` VARCHAR(255) NOT NULL DEFAULT 'draft' COLLATE utf8mb4_general_ci",
    );
  });

  it("adds a required default-less column with an invented default and drops it immediately", async () => {
    const { adapter, table, ddl } = setup();
    const added: TDbFieldMeta[] = [
      { ...pick(table, "note"), optional: false },
      { ...pick(table, "settings"), optional: false },
      pick(table, "location"),
    ];
    await adapter.syncColumns(diff({ added }));
    expect(ddl()).toEqual([
      "ALTER TABLE `pf_stamped` ADD COLUMN `note` TEXT NOT NULL DEFAULT ('')",
      "ALTER TABLE `pf_stamped` ALTER COLUMN `note` DROP DEFAULT",
      "ALTER TABLE `pf_stamped` ADD COLUMN `settings` JSON NOT NULL DEFAULT ('{}')",
      "ALTER TABLE `pf_stamped` ALTER COLUMN `settings` DROP DEFAULT",
      "ALTER TABLE `pf_stamped` ADD COLUMN `location` POINT SRID 4326 NOT NULL DEFAULT (ST_SRID(POINT(0, 0), 4326))",
      "ALTER TABLE `pf_stamped` ALTER COLUMN `location` DROP DEFAULT",
    ]);
  });

  it("a model default on a TEXT override uses the expression form; optional adds get no DROP DEFAULT", async () => {
    const { adapter, table, ddl } = setup();
    await adapter.syncColumns(diff({ added: [pick(table, "remarks"), pick(table, "note")] }));
    expect(ddl()).toEqual([
      "ALTER TABLE `pf_stamped` ADD COLUMN `remarks` TEXT NOT NULL DEFAULT ('n/a')",
      "ALTER TABLE `pf_stamped` ADD COLUMN `note` TEXT NULL",
    ]);
  });

  it("backfills NULLs with a type-aware value before NOT NULL", async () => {
    const { adapter, table, ddl } = setup();
    await adapter.syncColumns(
      diff({
        nullableChanged: [
          { field: { ...pick(table, "settings"), optional: false }, wasNullable: true },
          { field: { ...pick(table, "note"), optional: false }, wasNullable: true },
        ],
      }),
    );
    expect(ddl()).toEqual([
      "UPDATE `pf_stamped` SET `settings` = ('{}') WHERE `settings` IS NULL",
      "UPDATE `pf_stamped` SET `note` = ('') WHERE `note` IS NULL",
      "ALTER TABLE `pf_stamped` MODIFY COLUMN `settings` JSON NOT NULL",
      "ALTER TABLE `pf_stamped` MODIFY COLUMN `note` TEXT NOT NULL",
    ]);
  });
});

// ── Index key-length prefix + SUB_PART drift (since 0.1.128) ─────────────

describe("MysqlAdapter.syncIndexes — key-length prefixes", () => {
  let IpPreset: any;

  beforeAll(async () => {
    IpPreset = (await import("./fixtures/index-prefix.as")).IpPreset;
  });

  function createSql(driver: { calls: CapturedCall[] }, key: string): string {
    return driver.calls.find(
      (c) => c.sql.includes("INDEX") && c.sql.includes(key) && c.sql.startsWith("CREATE"),
    )!.sql;
  }

  it("prefixes only where the mapped type requires it", async () => {
    const driver = createDriver();
    const adapter = new MysqlAdapter(driver);
    await new AtscriptDbTable(IpPreset, adapter).syncIndexes();
    expect(createSql(driver, "ip_slug")).toBe(
      "CREATE UNIQUE INDEX `atscript__unique__ip_slug` ON `ip_presets` (`slug` ASC)",
    );
    expect(createSql(driver, "ip_body")).toBe(
      "CREATE INDEX `atscript__plain__ip_body` ON `ip_presets` (`body`(255) ASC)",
    );
    expect(createSql(driver, "ip_kind")).toBe(
      "CREATE INDEX `atscript__plain__ip_kind` ON `ip_presets` (`kind` ASC)",
    );
    expect(createSql(driver, "ip_title")).toBe(
      "CREATE UNIQUE INDEX `atscript__unique__ip_title` ON `ip_presets` (`title`(768) ASC)",
    );
    expect(createSql(driver, "ip_code")).toBe(
      "CREATE INDEX `atscript__plain__ip_code` ON `ip_presets` (`code` ASC)",
    );
    expect(createSql(driver, "ip_pair")).toBe(
      "CREATE INDEX `atscript__plain__ip_pair` ON `ip_presets` (`region` ASC, `zone` ASC)",
    );
    expect(createSql(driver, "ip_num")).toBe(
      "CREATE INDEX `atscript__plain__ip_num` ON `ip_presets` (`rank` ASC)",
    );
    const fulltext = createSql(driver, "ip_search");
    expect(fulltext).toContain("FULLTEXT INDEX");
    expect(fulltext).not.toContain("(255)");
  });

  it("rebuilds an index once when its live SUB_PART differs, and normalises a full-length SUB_PART", async () => {
    const stats = (
      INDEX_NAME: string,
      COLUMN_NAME: string,
      SUB_PART: number | null,
      SEQ_IN_INDEX = 1,
    ) => ({
      INDEX_NAME,
      COLUMN_NAME,
      SUB_PART,
      SEQ_IN_INDEX,
    });
    const driver = createDriver({
      all: [
        [
          "INFORMATION_SCHEMA.STATISTICS",
          [
            // created by an older release with (255) on a VARCHAR(1000) → must become (768)
            stats("atscript__unique__ip_title", "title", 255),
            // SUB_PART equal to the declared length is NOT a prefix → no rebuild
            stats("atscript__unique__ip_slug", "slug", 128),
            // TEXT member keeps its 255 → no rebuild
            stats("atscript__plain__ip_body", "body", 255),
            // an old (255) on a VARCHAR(64) that never needed one → rebuilt to no prefix
            stats("atscript__plain__ip_code", "code", 255),
            stats("atscript__plain__ip_kind", "kind", null),
            stats("atscript__plain__ip_pair", "region", null, 1),
            stats("atscript__plain__ip_pair", "zone", null, 2),
            stats("atscript__plain__ip_num", "rank", null),
            stats("atscript__fulltext__ip_search", "summary", null),
            stats("PRIMARY", "id", null),
          ],
        ],
      ],
    });
    const adapter = new MysqlAdapter(driver);
    await new AtscriptDbTable(IpPreset, adapter).syncIndexes();
    const ddl = driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
    expect(ddl).toEqual([
      "DROP INDEX `atscript__unique__ip_title` ON `ip_presets`",
      "CREATE UNIQUE INDEX `atscript__unique__ip_title` ON `ip_presets` (`title`(768) ASC)",
      "DROP INDEX `atscript__plain__ip_code` ON `ip_presets`",
      "CREATE INDEX `atscript__plain__ip_code` ON `ip_presets` (`code` ASC)",
    ]);
  });
});

describe("MysqlAdapter — columns entering the primary key (no helper index)", () => {
  // Live pf_tokens as PfTokenV2 left it: `code` is the key, `id` is a plain
  // column; PfTokenV1 wants `id` back as the AUTO_INCREMENT key.
  const liveV2 = (idType = "bigint") => [
    { COLUMN_NAME: "code", COLUMN_TYPE: "varchar(255)", EXTRA: "" },
    { COLUMN_NAME: "id", COLUMN_TYPE: idType, EXTRA: "" },
  ];

  it("adds an increment key column as a plain NOT NULL column — AUTO_INCREMENT waits for the rebuild", async () => {
    const driver = createDriver();
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(fx.PfTokenV1, adapter);
    await adapter.syncColumns(
      diff({ added: [pick(table, "id")], primaryKeyChanged: { from: ["code"], to: ["id"] } }),
    );
    const ddl = driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
    expect(ddl).toEqual(["ALTER TABLE `pf_tokens` ADD COLUMN `id` BIGINT NOT NULL"]);
    expect(ddl.join("\n")).not.toContain("AUTO_INCREMENT");
    expect(ddl.join("\n")).not.toContain("INDEX");
  });

  it("skips the MODIFYs of columns entering a pending key (the rebuild re-declares them)", async () => {
    const driver = createDriver();
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(fx.PfTokenV1, adapter);
    const id = pick(table, "id");
    const label = pick(table, "label");
    await adapter.syncColumns(
      diff({
        typeChanged: [
          { field: id, existingType: "DOUBLE" },
          { field: label, existingType: "VARCHAR(10)" },
        ],
        nullableChanged: [{ field: id, wasNullable: true }],
        defaultChanged: [{ field: id, oldDefault: "0" }],
        primaryKeyChanged: { from: ["code"], to: ["id"] },
      }),
    );
    const ddl = driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
    expect(ddl).toEqual(["ALTER TABLE `pf_tokens` MODIFY COLUMN `label` TEXT NOT NULL"]);
  });

  it("without a pending key change the same MODIFYs run (one per column)", async () => {
    const driver = createDriver();
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(fx.PfTokenV1, adapter);
    await adapter.syncColumns(
      diff({ typeChanged: [{ field: pick(table, "id"), existingType: "DOUBLE" }] }),
    );
    expect(driver.calls.filter((c) => c.method === "exec").map((c) => c.sql)).toEqual([
      "ALTER TABLE `pf_tokens` MODIFY COLUMN `id` BIGINT AUTO_INCREMENT NOT NULL",
    ]);
  });

  it("safe mode (rebuild skipped) leaves a valid schema; a later run completes the swap in ONE statement", async () => {
    // Run 1 (safe): only the ADD runs — no AUTO_INCREMENT column exists
    // without a key, and there is no helper index for the index sync to drop.
    const safeDriver = createDriver();
    const safeAdapter = new MysqlAdapter(safeDriver);
    const table = new AtscriptDbTable(fx.PfTokenV1, safeAdapter);
    const change = diff({
      added: [pick(table, "id")],
      primaryKeyChanged: { from: ["code"], to: ["id"] },
    });
    await safeAdapter.syncColumns(change);
    await safeAdapter.syncIndexes();
    const safeDdl = safeDriver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
    expect(safeDdl.filter((d) => d.startsWith("ALTER TABLE"))).toEqual([
      "ALTER TABLE `pf_tokens` ADD COLUMN `id` BIGINT NOT NULL",
    ]);
    expect(safeDdl.some((d) => d.startsWith("DROP INDEX"))).toBe(false);
    expect(safeDdl.join("\n")).not.toContain("AUTO_INCREMENT");

    // Run 2 (not safe): `id` already exists (not in `added`), the rebuild
    // owns it — AUTO_INCREMENT and the key land in the same statement.
    const driver = createDriver({ all: [["INFORMATION_SCHEMA.COLUMNS", liveV2()]] });
    const adapter = new MysqlAdapter(driver);
    new AtscriptDbTable(fx.PfTokenV1, adapter);
    await adapter.syncColumns(diff({ primaryKeyChanged: { from: ["code"], to: ["id"] } }));
    await adapter.rebuildPrimaryKey({ from: ["code"], to: ["id"] });
    const ddl = driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
    expect(ddl).toEqual([
      "ALTER TABLE `pf_tokens` MODIFY COLUMN `id` BIGINT AUTO_INCREMENT NOT NULL, DROP PRIMARY KEY, ADD PRIMARY KEY (`id`)",
    ]);
  });

  it("moving the key from one AUTO_INCREMENT column to a new one never has two AUTO_INCREMENT columns outside one statement", async () => {
    // Live: `id` BIGINT AUTO_INCREMENT PRIMARY KEY (PfTokenV1); desired: key on
    // a new increment column `seq`, `id` kept as a plain number (PfTokenSeq).
    // The canned COLUMNS row is what the rebuild's probe sees AFTER
    // syncColumns' `MODIFY id DOUBLE NOT NULL` removed the AUTO_INCREMENT.
    const driver = createDriver({
      all: [
        ["INFORMATION_SCHEMA.COLUMNS", [{ COLUMN_NAME: "id", COLUMN_TYPE: "double", EXTRA: "" }]],
      ],
    });
    const adapter = new MysqlAdapter(driver);
    const table = new AtscriptDbTable(fx.PfTokenSeq, adapter);
    const change = diff({
      added: [pick(table, "seq")],
      typeChanged: [{ field: pick(table, "id"), existingType: "BIGINT" }],
      primaryKeyChanged: { from: ["id"], to: ["seq"] },
    });
    await adapter.syncColumns(change);
    await adapter.rebuildPrimaryKey(change.primaryKeyChanged!);
    const ddl = driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
    expect(ddl).toEqual([
      "ALTER TABLE `pf_tokens` ADD COLUMN `seq` BIGINT NOT NULL",
      "ALTER TABLE `pf_tokens` MODIFY COLUMN `id` DOUBLE NOT NULL",
      "ALTER TABLE `pf_tokens` MODIFY COLUMN `seq` BIGINT AUTO_INCREMENT NOT NULL, DROP PRIMARY KEY, ADD PRIMARY KEY (`seq`)",
    ]);
    // The only AUTO_INCREMENT declaration is in the statement that also adds the key
    const withAi = ddl.filter((d) => d.includes("AUTO_INCREMENT"));
    expect(withAi).toHaveLength(1);
    expect(withAi[0]).toContain("ADD PRIMARY KEY");
  });
});

// ── Administrative adapter (no registered readable) ────────────────────────

// `DbSpace` runs the name-taking primitives (drop by name, inbound FKs) on a
// factory-fresh adapter that never had a readable registered. Everything —
// the schema included — must come from the pool (COALESCE(NULL, DATABASE())),
// never from `this._table`.
describe("MysqlAdapter — administrative adapter (no registered readable)", () => {
  it("runs every name-taking primitive without a readable; the schema falls through to DATABASE()", async () => {
    const driver = createDriver({
      get: [
        ["FROM `old_tokens`", { present: 1 }],
        ["INFORMATION_SCHEMA.TABLES", { TABLE_TYPE: "VIEW" }],
      ],
      all: [
        [
          "REFERENCED_TABLE_NAME = ?",
          [
            {
              TABLE_NAME: "children",
              CONSTRAINT_NAME: "fk1",
              COLUMN_NAME: "parentId",
              REFERENCED_COLUMN_NAME: "id",
            },
          ],
        ],
        [
          "INFORMATION_SCHEMA.COLUMNS",
          [
            {
              COLUMN_NAME: "id",
              COLUMN_TYPE: "int",
              IS_NULLABLE: "NO",
              COLUMN_DEFAULT: null,
              SRS_ID: null,
              IS_PK: 1,
            },
          ],
        ],
      ],
    });
    const adapter = new MysqlAdapter(driver);

    expect(await adapter.hasRows("old_tokens")).toBe(true);
    expect(await adapter.getReferencingForeignKeys("parents")).toEqual([
      { table: "children", fields: ["parentId"], targetFields: ["id"] },
    ]);
    expect(await adapter.getObjectKind("v")).toBe("view");
    expect(await adapter.getExistingColumnsForTable("parents")).toEqual([
      { name: "id", type: "INT", notnull: true, pk: true, dflt_value: undefined },
    ]);
    await adapter.dropViewByName("v");
    await adapter.dropTableByName("parents");
    await adapter.dropTablesByName(["cycle_a", "cycle_b"]);

    const [rows, fks, kind, cols, ...ddl] = driver.calls;
    expect(rows.sql).toBe("SELECT EXISTS(SELECT 1 FROM `old_tokens`) AS present");
    expect(fks.sql).toContain("REFERENCED_TABLE_SCHEMA = COALESCE(?, DATABASE())");
    expect(fks.params).toEqual(["parents", null]);
    expect(kind.sql).toContain("TABLE_SCHEMA = COALESCE(?, DATABASE())");
    expect(kind.params).toEqual(["v", null]);
    expect(cols.sql).toContain("c.TABLE_SCHEMA = COALESCE(?, DATABASE())");
    expect(cols.params).toEqual(["parents", null]);
    expect(ddl.map((c) => `${c.via}:${c.sql}`)).toEqual([
      "pool:DROP VIEW IF EXISTS `v`",
      "conn:SET FOREIGN_KEY_CHECKS = 0",
      "conn:DROP TABLE IF EXISTS `parents`",
      "conn:SET FOREIGN_KEY_CHECKS = 1",
      "conn:SET FOREIGN_KEY_CHECKS = 0",
      "conn:DROP TABLE IF EXISTS `cycle_a`",
      "conn:SET FOREIGN_KEY_CHECKS = 1",
      "conn:SET FOREIGN_KEY_CHECKS = 0",
      "conn:DROP TABLE IF EXISTS `cycle_b`",
      "conn:SET FOREIGN_KEY_CHECKS = 1",
    ]);
    expect(driver.releaseCount()).toBe(3);
  });

  it("DbSpace admin path: inbound FKs and drops of a removed table never touch a readable", async () => {
    const driver = createDriver({ all: [["REFERENCED_TABLE_NAME = ?", []]] });
    const space = new DbSpace(() => new MysqlAdapter(driver));
    space.getTable(fx.PfParent); // one bound adapter exists — the admin adapter is a different, unbound one
    expect(await space.getReferencingForeignKeys("gone_parents")).toEqual([]);
    await space.dropTableByName("gone_parents");
    await space.dropTablesByName(["gone_a", "gone_b"]);
    expect(driver.calls[0].params).toEqual(["gone_parents", null]);
    expect(driver.calls.filter((c) => c.sql.startsWith("DROP TABLE")).map((c) => c.sql)).toEqual([
      "DROP TABLE IF EXISTS `gone_parents`",
      "DROP TABLE IF EXISTS `gone_a`",
      "DROP TABLE IF EXISTS `gone_b`",
    ]);
  });

  it("table-scoped operations on an unbound adapter fail with a clear error, not a TypeError", async () => {
    const adapter = new MysqlAdapter(createDriver());
    await expect(adapter.hasRows()).rejects.toThrow(/no registered readable/);
  });
});
