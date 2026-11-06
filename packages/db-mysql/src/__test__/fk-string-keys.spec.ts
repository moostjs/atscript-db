import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace, NoopLogger } from "@atscript/db";
import type { TDbFieldMeta, TExistingColumn } from "@atscript/db";
import { computeColumnDiff } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { prepareFixtures, createMockDriver } from "./test-utils";

// MySQL keys a foreign key on full columns: a TEXT column cannot be indexed
// without a key-length prefix, on either side. Every string a foreign key
// uses — the referencing column and the referenced key — maps to VARCHAR,
// the same length on both sides. The referenced side is known from the
// space: schema sync registers every type it syncs before mapping any.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/fk-string-keys.as");
});

const allTypes = () => [
  fx.FskSlugged,
  fx.FskRef,
  fx.FskPlainKey,
  fx.FskSizedKey,
  fx.FskKeyRef,
  fx.FskPost,
  fx.FskTag,
  fx.FskPostTag,
  fx.FskLatin,
  fx.FskLatinRef,
];

/** A space over a mock driver with `types` (default: every fixture) registered. */
function spaceOf(types = allTypes(), warnings?: string[]) {
  const driver = createMockDriver();
  const logger = { ...NoopLogger, warn: (...a: unknown[]) => warnings?.push(a.join(" ")) };
  const space = new DbSpace(() => new MysqlAdapter(driver), { logger });
  for (const type of types) space.getTable(type);
  return { driver, space };
}

function tableOf(type: unknown, types?: unknown[]) {
  const table = spaceOf(types as any[] | undefined).space.getTable(type as any);
  return { adapter: table.dbAdapter as MysqlAdapter, table };
}

/** `path → mapped type` for every column of `type`. */
function mappedTypes(type: unknown, types?: unknown[]): Record<string, string> {
  const { adapter, table } = tableOf(type, types);
  return Object.fromEntries(
    table.columnDescriptors.map((f: TDbFieldMeta) => [f.path, adapter.typeMapper(f)]),
  );
}

async function createTableSql(type: unknown): Promise<string> {
  const { driver, space } = spaceOf();
  await space.getTable(type as any).dbAdapter.ensureTable();
  return driver.calls.find((c) => c.sql.startsWith("CREATE TABLE"))!.sql;
}

async function indexSql(type: unknown): Promise<string[]> {
  const { driver, space } = spaceOf();
  await space.getTable(type as any).syncIndexes();
  return driver.calls
    .filter((c) => c.method === "exec" && c.sql.startsWith("CREATE"))
    .map((c) => c.sql);
}

describe("MySQL — string columns of a foreign key are VARCHAR on both sides", () => {
  it("a unique string referenced by a foreign key is VARCHAR (its length, else 255)", () => {
    expect(mappedTypes(fx.FskSlugged)).toMatchObject({
      slug: "VARCHAR(255)",
      code: "VARCHAR(40)",
      region: "VARCHAR(255)",
      zone: "VARCHAR(255)",
      // a string no key uses keeps TEXT
      label: "TEXT",
    });
  });

  it("a unique string no foreign key references keeps TEXT (its index takes a prefix)", async () => {
    expect(mappedTypes(fx.FskTag).name).toBe("TEXT");
    // the referenced table alone, without the referencing one registered
    expect(mappedTypes(fx.FskSlugged, [fx.FskSlugged]).slug).toBe("TEXT");
    expect(await indexSql(fx.FskTag)).toContain(
      "CREATE UNIQUE INDEX `atscript__unique__fsk_tag_name_idx` ON `fsk_tags` (`name`(255) ASC)",
    );
  });

  it("the referencing columns take the referenced key's type", () => {
    expect(mappedTypes(fx.FskRef)).toMatchObject({
      sluggedSlug: "VARCHAR(255)",
      sluggedCode: "VARCHAR(40)",
      pairRegion: "VARCHAR(255)",
      pairZone: "VARCHAR(255)",
      note: "TEXT",
    });
  });

  it("CREATE TABLE of both sides uses VARCHAR, and the foreign keys reference them", async () => {
    const target = await createTableSql(fx.FskSlugged);
    expect(target).toContain("`slug` VARCHAR(255)");
    expect(target).toContain("`code` VARCHAR(40) NOT NULL");
    expect(target).toContain("`region` VARCHAR(255) NOT NULL");
    expect(target).toContain("`zone` VARCHAR(255) NOT NULL");
    expect(target).toContain("`label` TEXT NOT NULL");

    const refs = await createTableSql(fx.FskRef);
    expect(refs).toContain("`sluggedSlug` VARCHAR(255)");
    expect(refs).toContain("`sluggedCode` VARCHAR(40)");
    expect(refs).toContain("`pairRegion` VARCHAR(255)");
    expect(refs).toContain("`pairZone` VARCHAR(255)");
    expect(refs).toContain("FOREIGN KEY (`sluggedSlug`) REFERENCES `fsk_slugged` (`slug`)");
    expect(refs).toContain(
      "FOREIGN KEY (`pairRegion`, `pairZone`) REFERENCES `fsk_slugged` (`region`, `zone`)",
    );
    expect(refs).not.toMatch(/`(sluggedSlug|sluggedCode|pairRegion|pairZone)` TEXT/);
  });

  it("a reference column takes the referenced column's character set and collation", async () => {
    const target = await createTableSql(fx.FskSlugged);
    expect(target).toContain("`handle` VARCHAR(255) NOT NULL COLLATE utf8mb4_general_ci");
    expect(target).toContain("`sku` VARCHAR(20) CHARACTER SET ascii NOT NULL");
    const refs = await createTableSql(fx.FskRef);
    expect(refs).toContain("`sluggedHandle` VARCHAR(255) COLLATE utf8mb4_general_ci");
    expect(refs).toContain("`sluggedSku` VARCHAR(20) CHARACTER SET ascii,");
    // a reference to a column without its own collation declares none
    expect(refs).toMatch(/`sluggedSlug` VARCHAR\(255\),/);
  });

  it("the referenced unique keys and an index on a reference column take no key-length prefix", async () => {
    expect(await indexSql(fx.FskSlugged)).toEqual(
      expect.arrayContaining([
        "CREATE UNIQUE INDEX `atscript__unique__fsk_slug_idx` ON `fsk_slugged` (`slug` ASC)",
        "CREATE UNIQUE INDEX `atscript__unique__fsk_code_idx` ON `fsk_slugged` (`code` ASC)",
        "CREATE UNIQUE INDEX `atscript__unique__fsk_pair_idx` ON `fsk_slugged` (`region` ASC, `zone` ASC)",
      ]),
    );
    expect(await indexSql(fx.FskRef)).toContain(
      "CREATE INDEX `atscript__plain__fsk_ref_code_idx` ON `fsk_refs` (`sluggedCode` ASC)",
    );
  });

  it("a reference to a string primary key matches its VARCHAR length", async () => {
    expect(mappedTypes(fx.FskPlainKey).key).toBe("VARCHAR(255)");
    expect(mappedTypes(fx.FskSizedKey).key).toBe("VARCHAR(64)");
    expect(mappedTypes(fx.FskKeyRef)).toMatchObject({
      plainKey: "VARCHAR(255)",
      sizedKey: "VARCHAR(64)",
    });
    const refs = await createTableSql(fx.FskKeyRef);
    expect(refs).toContain("`plainKey` VARCHAR(255)");
    expect(refs).toContain("`sizedKey` VARCHAR(64)");
  });

  it("a @db.rel.via junction keyed by strings uses the keys' VARCHAR types", async () => {
    expect(mappedTypes(fx.FskPost).uid).toBe("VARCHAR(36)");
    expect(mappedTypes(fx.FskTag).code).toBe("VARCHAR(255)");
    const junction = await createTableSql(fx.FskPostTag);
    expect(junction).toContain("`postUid` VARCHAR(36) NOT NULL");
    expect(junction).toContain("`tagCode` VARCHAR(255) NOT NULL");
    expect(junction).toContain("FOREIGN KEY (`postUid`) REFERENCES `fsk_posts` (`uid`)");
    expect(junction).toContain("FOREIGN KEY (`tagCode`) REFERENCES `fsk_tags` (`code`)");
  });

  it("a live column already of the mapped VARCHAR type is not altered; a TEXT one is", () => {
    const { adapter, table } = tableOf(fx.FskRef);
    const live = (type: string): TExistingColumn[] =>
      table.columnDescriptors.map((f: TDbFieldMeta) => ({
        name: f.physicalName,
        type: f.path === "sluggedSlug" ? type : adapter.typeMapper(f).toLowerCase(),
        notnull: !f.optional,
        pk: f.isPrimaryKey,
      }));
    const tm = (f: TDbFieldMeta) => adapter.typeMapper(f);
    expect(
      computeColumnDiff(table.columnDescriptors, live("varchar(255)"), tm).typeChanged,
    ).toEqual([]);
    expect(
      computeColumnDiff(table.columnDescriptors, live("text"), tm).typeChanged.map(
        (c) => c.field.path,
      ),
    ).toEqual(["sluggedSlug"]);
  });

  it("a reference column takes the referenced TABLE's character set and collation when they differ", async () => {
    const warnings: string[] = [];
    const { driver, space } = spaceOf(allTypes(), warnings);
    await space.getTable(fx.FskLatin).dbAdapter.ensureTable();
    await space.getTable(fx.FskLatinRef).dbAdapter.ensureTable();
    const creates = driver.calls.filter((c) => c.sql.startsWith("CREATE TABLE")).map((c) => c.sql);
    expect(creates[0]).toContain("`code` VARCHAR(255) NOT NULL");
    expect(creates[0]).toContain("DEFAULT CHARSET=latin1");
    // the referenced table's latin1 (default collation) — the column's own
    // utf8mb4 / binary declarations are not used, and a warning says so
    expect(creates[1]).toContain("`code` VARCHAR(255) CHARACTER SET latin1,");
    expect(creates[1]).toContain("`code2` VARCHAR(255) CHARACTER SET latin1,");
    expect(creates[1]).not.toContain("utf8mb4_bin");
    expect(warnings).toEqual([
      expect.stringContaining(
        '"fsk_latin_refs.code2": its own character set / collation is not used',
      ),
    ]);
    // a table in the same character set as the referenced one adds nothing
    const refs = await createTableSql(fx.FskRef);
    expect(refs).toMatch(/`sluggedSlug` VARCHAR\(255\),/);
  });

  it("a column in a 1-byte character set is keyed in full up to its own limit", async () => {
    expect(await indexSql(fx.FskSlugged)).toContain(
      "CREATE UNIQUE INDEX `atscript__unique__fsk_long_idx` ON `fsk_slugged` (`longCode` ASC)",
    );
  });
});

const stats = (INDEX_NAME: string, SUB_PART: number | null, INDEX_TYPE = "BTREE") => ({
  INDEX_NAME,
  COLUMN_NAME: "name",
  SUB_PART,
  INDEX_TYPE,
});

async function modifyName(rows: unknown[], existingType: string, type = fx.FskTag) {
  const driver = createMockDriver({ all: [["INFORMATION_SCHEMA.STATISTICS", rows]] });
  const space = new DbSpace(() => new MysqlAdapter(driver));
  const table = space.getTable(type);
  const field = table.fieldDescriptors.find((f: TDbFieldMeta) => f.path === "name")!;
  await (table.dbAdapter as MysqlAdapter).syncColumns({
    added: [],
    removed: [],
    renamed: [],
    typeChanged: [{ field, existingType }],
    nullableChanged: [],
    defaultChanged: [],
    conflicts: [],
  });
  return driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
}

describe("MySQL — a column whose new type needs a key-length prefix", () => {
  it("drops the managed indexes keying it in full before MODIFY (index sync re-creates them with the prefix)", async () => {
    const ddl = await modifyName(
      [
        stats("atscript__unique__fsk_tag_name_idx", null),
        stats("atscript__plain__fsk_tag_name_prefixed", 255),
        stats("atscript__fulltext__fsk_tag_search", null, "FULLTEXT"),
        stats("own_name_idx", null),
      ],
      "varchar(255)",
    );
    const modify = ddl.findIndex((d) => d.includes("MODIFY COLUMN `name` TEXT"));
    expect(modify).toBeGreaterThan(0);
    expect(ddl.slice(0, modify).filter((d) => d.startsWith("DROP INDEX"))).toEqual([
      "DROP INDEX `atscript__unique__fsk_tag_name_idx` ON `fsk_tags`",
    ]);
  });

  it("leaves the indexes alone when the new type is keyed in full", async () => {
    const ddl = await modifyName(
      [stats("atscript__unique__fsk_tag_name_idx", null)],
      "text",
      fx.FskTagSized,
    );
    expect(ddl.some((d) => d.startsWith("DROP INDEX"))).toBe(false);
    expect(ddl.some((d) => d.includes("MODIFY COLUMN `name` VARCHAR(80)"))).toBe(true);
  });
});

describe("MySQL — dropping a foreign key drops the index InnoDB created for it", () => {
  async function dropRefFk(indexColumns: string[]) {
    const driver = createMockDriver({
      all: [
        ["INDEX_NAME = ?", indexColumns.map((COLUMN_NAME) => ({ COLUMN_NAME }))],
        [
          "REFERENCED_TABLE_NAME IS NOT NULL",
          [{ CONSTRAINT_NAME: "fsk_refs_ibfk_1", COLUMN_NAME: "sluggedSlug" }],
        ],
      ],
    });
    const space = new DbSpace(() => new MysqlAdapter(driver));
    await space.getTable(fx.FskRef).dbAdapter.dropForeignKeys!(["sluggedSlug"]);
    return driver.calls.filter((c) => c.method === "exec").map((c) => c.sql);
  }

  it("drops the implicit index named after the constraint's first column", async () => {
    expect(await dropRefFk(["sluggedSlug"])).toEqual([
      "ALTER TABLE `fsk_refs` DROP FOREIGN KEY `fsk_refs_ibfk_1`",
      "DROP INDEX `sluggedSlug` ON `fsk_refs`",
    ]);
  });

  it("keeps an index of that name over other columns", async () => {
    expect(await dropRefFk(["sluggedSlug", "note"])).toEqual([
      "ALTER TABLE `fsk_refs` DROP FOREIGN KEY `fsk_refs_ibfk_1`",
    ]);
  });
});
