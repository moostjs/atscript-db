import path from "path";

import { DbError, type DbSpace } from "@atscript/db";
import { expect } from "vite-plus/test";
import { prepareFixtures as prepare } from "@atscript/typescript/test-utils";
import dbPlugin from "@atscript/db/plugin";

import { createAdapter } from "../index";

export async function prepareFixtures() {
  const fixturesDir = path.join(path.dirname(import.meta.url.slice(7)), "fixtures");
  await prepare({
    rootDir: fixturesDir,
    // Memory adapter has no engine plugin — only the core db plugin supplies
    // the `@db.*` / `@meta.id` annotations the fixtures use.
    plugins: [dbPlugin()],
  });
}

export function createTestSpace() {
  return createAdapter();
}

/** A well-formed User payload; version is server-managed and omitted. */
export function user(over: Record<string, unknown>): any {
  return { name: "N", email: `${over.id as string}@x.com`, age: 20, ...over };
}

/** Ensures the table + records unique indexes for each model on the space. */
export async function bootstrapStoredTables(space: DbSpace, tables: any[]): Promise<void> {
  for (const t of tables) {
    const adapter = space.getAdapter(t);
    await adapter.ensureTable();
    await adapter.syncIndexes();
  }
}

/** The `DbError` a write rejects with (fails the test when it resolves or throws something else). */
export async function caught(p: Promise<unknown>): Promise<DbError> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DbError);
  return error as DbError;
}
