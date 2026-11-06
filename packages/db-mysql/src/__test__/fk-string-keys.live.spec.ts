import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";

import { MysqlAdapter } from "../mysql-adapter";
import { Mysql2Driver } from "../mysql2-driver";
import { prepareFixtures } from "./test-utils";
import { mysqlReachable, recreateMysqlDatabase, dropMysqlDatabase } from "./live-server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Server-gated: runs against a live MySQL 8 when one is reachable, skips
// otherwise. Foreign keys over string columns — to a unique optional string,
// a composite unique key, string primary keys with and without a length, a
// junction keyed by strings, and keys with their own collation / charset —
// are created by schema sync, enforced, and stable on a re-run. A key an
// earlier release created as TEXT (its referencing table failed to sync)
// becomes VARCHAR in place.

const DB = "fk_string_keys";

const reachable = await mysqlReachable();

let fx: Record<string, any>;
let driver: Mysql2Driver;
let space: DbSpace;

const all = () => [
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

async function columnType(table: string, column: string): Promise<string | undefined> {
  const row = await driver.get<{ COLUMN_TYPE: string }>(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return row?.COLUMN_TYPE;
}

async function foreignKeyColumns(table: string): Promise<string[]> {
  const rows = await driver.all<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY COLUMN_NAME`,
    [table],
  );
  return rows.map((r) => r.COLUMN_NAME);
}

describe.skipIf(!reachable)("[mysql live] foreign keys over string columns", () => {
  beforeAll(async () => {
    await prepareFixtures();
    fx = await import("./fixtures/fk-string-keys.as");
    driver = new Mysql2Driver(await recreateMysqlDatabase(DB));
    space = new DbSpace(() => new MysqlAdapter(driver), { onClose: () => driver.close() });
  });

  afterAll(async () => {
    await space?.close();
    await dropMysqlDatabase(DB);
  });

  it("an earlier release's TEXT key becomes VARCHAR once a foreign key references it", async () => {
    // fsk_slugged as an earlier release left it: its sync passed (`slug` TEXT,
    // unique on a prefix), the referencing table's failed
    await driver.exec(
      "CREATE TABLE `fsk_slugged` (`id` BIGINT AUTO_INCREMENT PRIMARY KEY, `slug` TEXT, `code` VARCHAR(40) NOT NULL, `region` TEXT NOT NULL, `zone` TEXT NOT NULL, `handle` TEXT NOT NULL COLLATE utf8mb4_general_ci, `sku` VARCHAR(20) CHARACTER SET ascii NOT NULL, `label` TEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
    );
    await driver.exec(
      "CREATE UNIQUE INDEX `atscript__unique__fsk_slug_idx` ON `fsk_slugged` (`slug`(255) ASC)",
    );
    await driver.exec(
      "INSERT INTO `fsk_slugged` (`slug`, `code`, `region`, `zone`, `handle`, `sku`, `label`) VALUES ('s0', 'c0', 'eu', 'b', 'H0', 'SKU0', 'zero')",
    );
  });

  it("creates every foreign key, enforces it, and is up to date on a re-run", async () => {
    const result = await new SchemaSync(space).run(all(), { force: true, onError: "silent" });
    expect(result.entries.flatMap((e) => e.errors)).toEqual([]);
    expect(result.status).toBe("synced");

    expect(await columnType("fsk_slugged", "slug")).toBe("varchar(255)");
    expect(await columnType("fsk_slugged", "label")).toBe("text");
    // a unique string nothing references keeps TEXT
    expect(await columnType("fsk_tags", "name")).toBe("text");
    expect(await columnType("fsk_refs", "sluggedSlug")).toBe("varchar(255)");
    expect(await columnType("fsk_refs", "sluggedSku")).toBe("varchar(20)");
    expect(await columnType("fsk_post_tags", "postUid")).toBe("varchar(36)");
    expect(await foreignKeyColumns("fsk_refs")).toEqual([
      "pairRegion",
      "pairZone",
      "sluggedCode",
      "sluggedHandle",
      "sluggedSku",
      "sluggedSlug",
    ]);
    expect(await foreignKeyColumns("fsk_key_refs")).toEqual(["plainKey", "sizedKey"]);
    expect(await foreignKeyColumns("fsk_post_tags")).toEqual(["postUid", "tagCode"]);
    // a referenced table in another character set
    expect(await foreignKeyColumns("fsk_latin_refs")).toEqual(["code", "code2"]);
    // a latin1 column keyed in full up to 3072 characters
    expect(
      await driver.get<{ SUB_PART: number | null }>(
        `SELECT SUB_PART FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fsk_slugged' AND INDEX_NAME = 'atscript__unique__fsk_long_idx'`,
      ),
    ).toEqual({ SUB_PART: null });

    const slugged = space.getTable(fx.FskSlugged);
    expect(await slugged.count({ filter: { slug: "s0" } })).toBe(1);
    await slugged.insertOne({
      slug: "s1",
      code: "c1",
      region: "eu",
      zone: "a",
      handle: "Handle",
      sku: "SKU1",
      label: "one",
    });
    const refs = space.getTable(fx.FskRef);
    // a nocase key matches its reference case-insensitively
    await refs.insertOne({ sluggedSlug: "s1", sluggedHandle: "handle", note: "ok" });
    await expect(refs.insertOne({ sluggedSlug: "missing", note: "bad" })).rejects.toMatchObject({
      code: "FK_VIOLATION",
    });

    expect((await new SchemaSync(space).run(all())).status).toBe("up-to-date");
  });
});
