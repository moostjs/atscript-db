/**
 * Compile-only assertions for the `Client` write payloads (`vp lint`
 * type-checks this file; the blocks never reach `fetch()`).
 *
 * An interface — or a generated model's instance type — has no index
 * signature, so a payload typed `Record<string, unknown>` rejects it. Both an
 * untyped `Client` and a typed `Client<typeof Model>` take such values.
 */
import { describe, it, expectTypeOf } from "vite-plus/test";

import { Client } from "../client";
import type { InsertOf, PatchOf, RowOf } from "../types";
import type { TDbInsertManyResult, TDbInsertResult } from "@atscript/db";

interface Product {
  id: number;
  name: string;
  price: number;
  stock?: number;
  tags: string[];
}

// Shaped like a generated Atscript class.
declare class ProductModel {
  id: number;
  name: string;
  price: number;
  stock?: number;
  tags: string[];
  static __is_atscript_annotated_type: true;
  static type: { __dataType?: ProductModel };
  static __ownProps: { id: number; name: string; price: number; stock?: number; tags: string[] };
  static __pk: number;
}

declare const product: Product;
declare const model: ProductModel;
declare const patch: Pick<Product, "id"> & Partial<Product>;

const never = (): boolean => Math.random() > 2;

describe("Client write payloads", () => {
  it("an untyped client takes interface values on every write", () => {
    if (never()) {
      const products = new Client("/api/products");
      expectTypeOf(products.insert(product)).resolves.toEqualTypeOf<TDbInsertResult>();
      expectTypeOf(products.insert([product])).resolves.toEqualTypeOf<TDbInsertManyResult>();
      void products.update(product);
      void products.update(patch);
      void products.update([patch]);
      void products.replace(product);
      void products.update({ id: 1, price: { $inc: 1 }, $cas: { version: 2 } });
    }
  });

  it("a typed client takes the app's interface and the generated instance type", () => {
    if (never()) {
      const products = new Client<typeof ProductModel>("/api/products");
      expectTypeOf(products.insert(product)).resolves.toEqualTypeOf<TDbInsertResult>();
      expectTypeOf(products.insert([model])).resolves.toEqualTypeOf<TDbInsertManyResult>();
      void products.update(product);
      void products.update(patch);
      void products.update(model);
      void products.replace(product);
      void products.replace([model]);
    }
  });

  it("a typed client types field and array operators on update only", () => {
    if (never()) {
      const products = new Client<typeof ProductModel>("/api/products");
      void products.update({ id: 1, price: { $mul: 1.1 }, stock: { $dec: 1 } });
      void products.update({ id: 1, tags: { $insert: ["sale"] }, $cas: { version: 3 } });
      // @ts-expect-error a string field takes no numeric operator
      void products.update({ id: 1, name: { $inc: 1 } });
      // @ts-expect-error field operators have no meaning on insert
      void products.insert({ name: "A", price: { $inc: 1 } });
      // @ts-expect-error unknown field on a typed client
      void products.update({ id: 1, nope: true });
    }
  });

  it("exports the payload types", () => {
    expectTypeOf<Product>().toMatchTypeOf<InsertOf<typeof ProductModel>>();
    expectTypeOf<Product>().toMatchTypeOf<PatchOf<typeof ProductModel>>();
    expectTypeOf<Product>().toMatchTypeOf<RowOf<typeof ProductModel>>();
    expectTypeOf<Product>().toMatchTypeOf<PatchOf<Record<string, unknown>>>();
  });
});

describe("insert({ returning: true }) is single-row only", () => {
  it("an array with returning is a type error, typed or untyped", () => {
    if (never()) {
      const untyped = new Client("/api/products");
      void untyped.insert(product, { returning: true });
      // @ts-expect-error returning applies to a single row
      void untyped.insert([product], { returning: true });
      const typed = new Client<typeof ProductModel>("/api/products");
      // @ts-expect-error returning applies to a single row
      void typed.insert([product], { returning: true });
      void typed.insert(product, { returning: true });
      // @ts-expect-error unknown field on a typed client
      void typed.insert({ name: "A", nope: 1 }, { returning: true });
    }
  });
});
