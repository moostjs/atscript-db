import { describe, it, expectTypeOf } from "vite-plus/test";

import { $inc, $insert, $mul, $remove } from "../ops";
import type { AtscriptDbTable } from "../table/db-table";
import type { DbInsert, DbPatch, DbRow } from "../types";
import type { UsersTable } from "./fixtures/test-table.as";

/**
 * Compile-only assertions for the write payload types. `vp lint` type-checks
 * this file; the `if (Math.random() > 2)` blocks never run.
 *
 * - An interface (or a generated class instance) has no index signature, so a
 *   payload type that intersects `Record<string, unknown>` rejects it.
 * - Patches type the field operators the runtime accepts: `$inc` / `$dec` /
 *   `$mul` on number fields, the array ops on top-level arrays, `$cas`.
 */

interface Product {
  id: number;
  name: string;
  price: number;
  stock?: number;
  tags: string[];
  note?: string;
}

declare const product: Product;
declare const productPatch: Pick<Product, "id"> & Partial<Product>;
declare const users: AtscriptDbTable<typeof UsersTable>;
declare const user: UsersTable;
declare const untyped: AtscriptDbTable;

describe("write payloads accept interface values", () => {
  it("DbInsert / DbPatch / DbRow take an interface-typed value", () => {
    if (Math.random() > 2) {
      const ins: DbInsert<Product> = product;
      const patch: DbPatch<Product> = product;
      const partial: DbPatch<Product> = productPatch;
      const row: DbRow<Product> = product;
      void [ins, patch, partial, row];
    }
  });

  it("a typed table takes its own generated row type", () => {
    if (Math.random() > 2) {
      void users.insertOne(user);
      void users.insertMany([user]);
      void users.updateOne(user);
      void users.replaceOne(user);
      void users.bulkReplace([user]);
    }
  });

  it("an untyped table takes any object, interfaces included", () => {
    if (Math.random() > 2) {
      void untyped.insertOne(product);
      void untyped.updateOne(product);
      void untyped.replaceOne(product);
      void untyped.updateOne({ id: 1, $cas: { version: 3 } });
    }
  });
});

describe("DbPatch field operators", () => {
  it("number fields take $inc / $dec / $mul", () => {
    const a: DbPatch<Product> = { id: 1, price: { $inc: 5 }, stock: { $dec: 1 } };
    const b: DbPatch<Product> = { id: 1, price: $mul(1.1), stock: $inc() };
    void [a, b];
    // @ts-expect-error a string field takes no numeric operator
    const bad: DbPatch<Product> = { id: 1, name: { $inc: 1 } };
    // @ts-expect-error an unknown operator
    const bad2: DbPatch<Product> = { id: 1, price: { $pow: 2 } };
    void [bad, bad2];
  });

  it("top-level arrays take the array patch operators", () => {
    const a: DbPatch<Product> = { id: 1, tags: { $insert: ["new"] } };
    const b: DbPatch<Product> = { id: 1, tags: $remove(["old"]) };
    const c: DbPatch<Product> = { id: 1, tags: $insert(["x"]) };
    const d: DbPatch<Product> = { id: 1, tags: ["whole"] };
    void [a, b, c, d];
    // @ts-expect-error wrong element type
    const bad: DbPatch<Product> = { id: 1, tags: { $insert: [1] } };
    void bad;
  });

  it("$cas is accepted on patches and full rows, not on inserts", () => {
    const p: DbPatch<Product> = { id: 1, price: 2, $cas: { version: 4 } };
    void p;
    if (Math.random() > 2) {
      const r: DbRow<Product> = { ...product, $cas: { version: 4 } };
      void r;
    }
    // @ts-expect-error $cas has no meaning on insert
    const bad: DbInsert<Product> = { id: 1, $cas: { version: 4 } };
    // @ts-expect-error field operators have no meaning on insert
    const bad2: DbInsert<Product> = { id: 1, price: { $inc: 1 } };
    void [bad, bad2];
  });

  it("a typed table's updateOne takes operators, insertOne does not", () => {
    if (Math.random() > 2) {
      void users.updateOne({ id: 1, createdAt: { $inc: 1 } });
      // @ts-expect-error field operators have no meaning on insert
      void users.insertOne({ email: "a@b.c", createdAt: { $inc: 1 } });
      // @ts-expect-error unknown field on a typed table
      void users.updateOne({ id: 1, nope: 1 });
    }
  });

  it("DbPatch keeps every key optional and null on optional columns", () => {
    expectTypeOf<{ id: 1 }>().toMatchTypeOf<DbPatch<Product>>();
    expectTypeOf<{ id: 1; note: null }>().toMatchTypeOf<DbPatch<Product>>();
    expectTypeOf<{ id: 1; name: null }>().not.toMatchTypeOf<DbPatch<Product>>();
  });
});
