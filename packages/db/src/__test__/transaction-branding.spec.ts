import { describe, it, expect, beforeAll } from "vite-plus/test";

import { AtscriptDbTable } from "../table/db-table";
import type { DbQuery, TDbInsertManyResult } from "../types";

import { MockAdapter, prepareFixtures } from "./test-utils";

let DefaultItem: any;

/**
 * Transaction-state branding (since 0.1.128): `BaseDbAdapter.withTransaction`
 * stores `{ owner, state }` in the async-local chain, `owner` being the
 * adapter's `_transactionOwner()` (the driver / pool / client every adapter of
 * a space shares). `_getTransactionState()` only ever returns a state of the
 * same owner — another family's transaction is "no transaction of mine", and
 * a nested `withTransaction` from that family opens its own on top while the
 * outer family's statements keep seeing the outer transaction.
 */

interface FakeDriver {
  name: string;
}

/** An adapter family keyed on a driver object; records the owner of the state each write ran under. */
class FamilyAdapter extends MockAdapter {
  readonly txLog: string[] = [];
  readonly seen: string[] = [];
  private _seq = 0;

  constructor(readonly driver: FakeDriver) {
    super();
  }

  protected override _transactionOwner(): unknown {
    return this.driver;
  }

  protected override async _beginTransaction(): Promise<unknown> {
    const id = `${this.driver.name}${++this._seq}`;
    this.txLog.push(`begin:${id}`);
    return { owner: this.driver.name, id };
  }

  protected override async _commitTransaction(state: unknown): Promise<void> {
    this.txLog.push(`commit:${(state as { id: string }).id}`);
  }

  protected override async _rollbackTransaction(state: unknown): Promise<void> {
    this.txLog.push(`rollback:${(state as { id: string }).id}`);
  }

  private _observe(): void {
    const state = this._getTransactionState() as { id: string } | undefined;
    this.seen.push(state?.id ?? "autocommit");
  }

  override async insertMany(data: Array<Record<string, unknown>>): Promise<TDbInsertManyResult> {
    this._observe();
    return super.insertMany(data);
  }

  /** A bare statement — the table never wraps reads in a transaction of their own. */
  override async findOne(query: DbQuery): Promise<Record<string, unknown> | null> {
    this._observe();
    return super.findOne(query);
  }
}

describe("transaction-state branding by owner", () => {
  const driverA: FakeDriver = { name: "A" };
  const driverB: FakeDriver = { name: "B" };
  let a1: FamilyAdapter;
  let a2: FamilyAdapter;
  let b1: FamilyAdapter;
  let tableA1: AtscriptDbTable;
  let tableA2: AtscriptDbTable;
  let tableB1: AtscriptDbTable;

  beforeAll(async () => {
    await prepareFixtures();
    ({ DefaultItem } = await import("./fixtures/apply-defaults.as"));
  });

  const reset = () => {
    a1 = new FamilyAdapter(driverA);
    a2 = new FamilyAdapter(driverA);
    b1 = new FamilyAdapter(driverB);
    tableA1 = new AtscriptDbTable(DefaultItem, a1);
    tableA2 = new AtscriptDbTable(DefaultItem, a2);
    tableB1 = new AtscriptDbTable(DefaultItem, b1);
  };

  it("two adapters over the same driver share one transaction (nested same-owner joins)", async () => {
    reset();
    await a1.withTransaction(async () => {
      await tableA1.insertOne({ id: 1, name: "x" } as any);
      await a2.withTransaction(async () => tableA2.insertOne({ id: 2, name: "y" } as any));
    });
    expect(a1.txLog).toEqual(["begin:A1", "commit:A1"]);
    expect(a2.txLog).toEqual([]);
    expect(a1.seen).toEqual(["A1"]);
    expect(a2.seen).toEqual(["A1"]); // the other instance reads the same state
  });

  it("a foreign outer transaction is invisible: bare statements run autocommit, a nested withTransaction opens its own", async () => {
    reset();
    await b1.withTransaction(async () => {
      await tableA1.findOne({ filter: { id: 1 }, controls: {} }); // A has no transaction here
      await a1.withTransaction(async () => tableA1.insertOne({ id: 2, name: "y" } as any));
      await tableA1.insertOne({ id: 3, name: "z" } as any); // the table's own withTransaction → A's second transaction
      await tableB1.insertOne({ id: 4, name: "w" } as any);
    });
    expect(a1.seen).toEqual(["autocommit", "A1", "A2"]);
    expect(a1.txLog).toEqual(["begin:A1", "commit:A1", "begin:A2", "commit:A2"]);
    expect(b1.seen).toEqual(["B1"]);
    expect(b1.txLog).toEqual(["begin:B1", "commit:B1"]);
  });

  it("A-outer + B-inner: the outer family's statements inside the inner callback still see the outer transaction", async () => {
    reset();
    await a1.withTransaction(async () => {
      await b1.withTransaction(async () => {
        await tableA2.insertOne({ id: 1, name: "x" } as any);
        await tableB1.insertOne({ id: 2, name: "y" } as any);
      });
      await tableA1.insertOne({ id: 3, name: "z" } as any);
    });
    expect(a2.seen).toEqual(["A1"]);
    expect(a1.seen).toEqual(["A1"]);
    expect(b1.seen).toEqual(["B1"]);
    expect(a1.txLog).toEqual(["begin:A1", "commit:A1"]);
    expect(b1.txLog).toEqual(["begin:B1", "commit:B1"]);
  });

  it("a throw inside the inner family rolls back only its own transaction", async () => {
    reset();
    await a1.withTransaction(async () => {
      await tableA1.insertOne({ id: 1, name: "x" } as any);
      await b1
        .withTransaction(async () => {
          await tableB1.insertOne({ id: 2, name: "y" } as any);
          throw new Error("inner");
        })
        .catch(() => undefined);
      await tableA1.insertOne({ id: 3, name: "z" } as any);
    });
    expect(b1.txLog).toEqual(["begin:B1", "rollback:B1"]);
    expect(a1.txLog).toEqual(["begin:A1", "commit:A1"]);
    expect(a1.seen).toEqual(["A1", "A1"]);
  });

  it("the default owner is the adapter class: instances of one mock class share, unrelated classes do not", async () => {
    class Plain extends MockAdapter {
      readonly seen: unknown[] = [];
      protected override async _beginTransaction(): Promise<unknown> {
        return "plain-tx";
      }
      override async findOne(query: DbQuery) {
        this.seen.push(this._getTransactionState());
        return super.findOne(query);
      }
    }
    class Other extends MockAdapter {
      readonly seen: unknown[] = [];
      protected override async _beginTransaction(): Promise<unknown> {
        return "other-tx";
      }
      override async findOne(query: DbQuery) {
        this.seen.push(this._getTransactionState());
        return super.findOne(query);
      }
    }
    const p1 = new Plain();
    const p2 = new Plain();
    const o = new Other();
    const tp1 = new AtscriptDbTable(DefaultItem, p1);
    const tp2 = new AtscriptDbTable(DefaultItem, p2);
    const to = new AtscriptDbTable(DefaultItem, o);
    const probe = { filter: { id: 1 }, controls: {} };
    await p1.withTransaction(async () => {
      await tp1.findOne(probe);
      await tp2.findOne(probe);
      await to.findOne(probe);
    });
    expect(p1.seen).toEqual(["plain-tx"]);
    expect(p2.seen).toEqual(["plain-tx"]);
    expect(o.seen).toEqual([undefined]);
  });
});
