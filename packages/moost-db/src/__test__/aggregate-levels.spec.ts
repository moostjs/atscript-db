import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { createAdapter as createSqlite } from "@atscript/db-sqlite";
import { DbSpace, type TMetaResponse } from "@atscript/db";
import { SchemaSync } from "@atscript/db/sync";
import { HttpError } from "@moostjs/event-http";

import { AsDbController } from "../as-db.controller";
import type { TDbControlsType } from "../as-readable.controller";
import { AsJsonValueHelpController } from "../as-json-value-help.controller";
// The core test adapter has no package entry — the one relative import that stays.
import { MockAdapter } from "../../../db/src/__test__/test-utils";
import { makeValueHelpType } from "./actions-test-utils";
import { createMockApp, errorsOf, prepareFixtures, transformed } from "./test-utils";

/**
 * countDistinct over a field list, conditional aggregates (`$where`) and
 * two-level aggregates (`$from`) over HTTP (since 0.1.168): the URL forms
 * reach the table, every field a condition or an inner level reads passes
 * the request gate exactly like a filter / grouped field (a hidden field
 * answers like a nonexistent one, a write-only or non-filterable one is
 * refused), the inner level's gate runs before uniqu's `resolveNested`, a
 * permission layer sees the inner level through `validateControls(…,
 * "nested")` and can switch `$from` off, and every place without aggregates
 * refuses them instead of ignoring them.
 */

let AlhSale: any;
let AlhTicket: any;
let space: DbSpace;

const at = (iso: string) => Date.parse(iso);
const SALES = [
  {
    id: 1,
    region: "N",
    customerId: 1,
    status: "paid",
    amount: 10,
    cost: 1,
    margin: 0,
    createdAt: at("2026-01-05T00:00:00Z"),
  },
  {
    id: 2,
    region: "N",
    customerId: 1,
    status: "open",
    amount: 20,
    cost: 2,
    margin: 0,
    createdAt: at("2026-02-03T00:00:00Z"),
  },
  {
    id: 3,
    region: "N",
    customerId: 2,
    status: "paid",
    amount: 30,
    cost: 3,
    margin: 0,
    createdAt: at("2026-02-10T00:00:00Z"),
  },
  {
    id: 4,
    region: "S",
    customerId: 3,
    status: "paid",
    amount: 40,
    cost: 4,
    margin: 0,
    createdAt: at("2026-01-07T00:00:00Z"),
  },
  {
    id: 5,
    region: "S",
    customerId: 3,
    status: "open",
    amount: 50,
    cost: 5,
    margin: 0,
    createdAt: at("2026-03-01T00:00:00Z"),
  },
];

beforeAll(async () => {
  await prepareFixtures();
  ({ AlhSale, AlhTicket } = await import("./fixtures/aggregate-levels.as"));
  space = createSqlite(":memory:");
  const result = await new SchemaSync(space).run([AlhSale, AlhTicket], { force: true });
  expect(result.entries.filter((e) => e.status === "error")).toEqual([]);
  await space.getTable(AlhSale).insertMany(structuredClone(SALES) as never);
  await space
    .getTable(AlhTicket)
    .insertMany([{ id: 1, status: "open", priority: 1, region: "N" }] as never);
});

afterAll(async () => {
  await space?.close();
});

/** Hides `cost` from every request (a read scope). */
class HidingController extends AsDbController<any> {
  protected override hasField(path: string): boolean {
    return path !== "cost" && super.hasField(path);
  }
}

const sales = <C extends AsDbController<any>>(
  Ctrl: new (...args: any[]) => C = AsDbController as never,
): C => new Ctrl(createMockApp(), space.getTable(AlhSale));

/** The 400 the request answers — returned, or a thrown core `DbError` mapped as the HTTP interceptor does. */
async function rejected(res: Promise<unknown>): Promise<HttpError> {
  const settled = await res.catch(() => undefined);
  const err = settled instanceof HttpError ? settled : await transformed(res);
  expect(err.body.statusCode).toBe(400);
  return err;
}

const bodyOf = (e: HttpError) => e.body as unknown as { message: string; code?: string };

describe("URL forms reach the table", () => {
  it("a conditional aggregate and a countDistinct field list", async () => {
    const rows = await sales().query(
      "?$groupBy=region&$select=region,sum(amount|status=paid):paid,countDistinct(customerId,status):pairs&$sort=region",
    );
    expect(rows).toEqual([
      { region: "N", paid: 40, pairs: 3 },
      { region: "S", paid: 40, pairs: 2 },
    ]);
  });

  it("a two-level aggregate", async () => {
    const rows = await sales().query(
      "?$from=($groupBy=region,customerId&$select=sum(amount):spent)&$groupBy=region&$select=region,avg(spent):avgSpent,count(*):customers&$sort=region",
    );
    expect(rows).toEqual([
      { region: "N", avgSpent: 30, customers: 2 },
      { region: "S", avgSpent: 90, customers: 1 },
    ]);
  });

  it("a two-level aggregate without an outer $groupBy, filtered", async () => {
    expect(
      await sales().query(
        "?status=paid&$from=($groupBy=customerId&$select=count(*):n)&$select=max(n):most,count(*):buyers",
      ),
    ).toEqual([{ most: 1, buyers: 3 }]);
  });
});

describe("a condition's fields pass the filter gate", () => {
  it("a hidden field answers exactly like a nonexistent one", async () => {
    const ctrl = sales(HidingController);
    const hidden = await rejected(ctrl.query("?$groupBy=region&$select=count(*|cost>2):n"));
    const missing = await rejected(ctrl.query("?$groupBy=region&$select=count(*|nope>2):n"));
    expect(errorsOf(hidden)).toMatchObject([{ path: "cost", message: 'Unknown field "cost"' }]);
    expect(errorsOf(missing)).toMatchObject([{ path: "nope", message: 'Unknown field "nope"' }]);
  });

  it("a write-only field is refused like in a filter", async () => {
    const err = await rejected(sales().query("?$groupBy=region&$select=count(*|margin=0):n"));
    expect(errorsOf(err)[0]).toMatchObject({ path: "margin" });
    expect(errorsOf(err)[0].message).toMatch(/writeOnly/);
    // the same as the filter answers
    const filter = await rejected(sales().query("?margin=0&$groupBy=region"));
    expect(errorsOf(err)).toEqual(errorsOf(filter));
  });

  it("a field the table's filter policy does not open is refused", async () => {
    const tickets = new AsDbController(createMockApp(), space.getTable(AlhTicket));
    const err = await rejected(tickets.query("?$groupBy=region&$select=count(*|priority=1):n"));
    expect(errorsOf(err)[0].message).toMatch(/Filtering on field "priority" is not permitted/);
    expect(await tickets.query("?$groupBy=region&$select=region,count(*|status=open):n")).toEqual([
      { region: "N", n: 1 },
    ]);
  });

  it("an outer condition or order on an inner key field meets the table's filter / sort policy", async () => {
    const tickets = new AsDbController(createMockApp(), space.getTable(AlhTicket));
    const inner = "$from=($groupBy=region,priority,status&$select=count(*):n)";
    const filter = await rejected(tickets.query(`?${inner}&$select=sum(n|priority=1):t`));
    expect(errorsOf(filter)).toEqual(errorsOf(await rejected(tickets.query("?priority=1"))));
    const sort = await rejected(
      tickets.query(`?${inner}&$groupBy=priority&$select=priority,sum(n):t&$sort=priority`),
    );
    expect(errorsOf(sort)).toEqual(errorsOf(await rejected(tickets.query("?$sort=priority"))));
    // the policy's own fields pass, and an inner ALIAS is no field
    expect(
      await tickets.query(
        `?${inner}&$groupBy=status&$select=status,sum(n|status=open):t,sum(n|n>0):all&$sort=status`,
      ),
    ).toEqual([{ status: "open", t: 1, all: 1 }]);
  });

  it("a field-list entry is reported by its own name", async () => {
    const err = await rejected(
      sales(HidingController).query("?$select=countDistinct(region,cost)"),
    );
    expect(errorsOf(err)).toMatchObject([{ path: "cost", message: 'Unknown field "cost"' }]);
  });
});

describe("the inner level of $from is gated like a standalone query, before resolveNested", () => {
  it.each([
    ["$groupBy", "?$from=($groupBy=region,cost&$select=count(*):n)&$select=sum(n):t"],
    ["$select", "?$from=($groupBy=region&$select=sum(cost):c)&$select=sum(c):t"],
    ["$where", "?$from=($groupBy=region&$select=count(*|cost>1):c)&$select=sum(c):t"],
    [
      "$rowOrder",
      "?$from=($groupBy=region&$select=first(amount):f&$rowOrder=cost)&$select=sum(f):t",
    ],
  ])("a hidden field in the inner %s is Unknown field", async (_, url) => {
    const err = await rejected(sales(HidingController).query(url));
    expect(errorsOf(err)).toMatchObject([{ path: "cost", message: 'Unknown field "cost"' }]);
  });

  it("an outer sum over a hidden inner key never answers NOT_NUMERIC; a visible text key does", async () => {
    const hidden = await rejected(
      sales(HidingController).query("?$from=($groupBy=region,cost)&$select=sum(cost):t"),
    );
    expect(errorsOf(hidden)).toMatchObject([{ path: "cost", message: 'Unknown field "cost"' }]);
    const text = await rejected(
      sales().query("?$from=($groupBy=region,status)&$select=sum(status):t"),
    );
    expect(errorsOf(text)[0]).toMatchObject({ path: "$select", code: "AGG_NESTED_NOT_NUMERIC" });
  });

  it("a write-only inner key is refused like any grouped write-only field", async () => {
    const res = await sales().query("?$from=($groupBy=region,margin)&$select=count(*):n");
    expect(res).toBeInstanceOf(HttpError);
    expect(bodyOf(res as HttpError).message).toMatch(/writeOnly/);
  });

  it("an inner alias named like an inner $groupBy key answers as the SDK does (shape rules first)", async () => {
    const url = "?$from=($groupBy=region&$select=count(*):region)&$select=count(*):t";
    const err = await rejected(sales().query(url));
    expect(bodyOf(err).code).toBe("INVALID_QUERY");
    expect(errorsOf(err)[0]).toMatchObject({
      path: "$from.$select",
      code: "AGG_NESTED_DUPLICATE_COLUMN",
    });
    // the SDK's verdict on the same query
    const sdk = await space
      .getTable(AlhSale)
      .aggregate({
        filter: {},
        controls: {
          $from: { $groupBy: ["region"], $select: [{ $fn: "count", $field: "*", $as: "region" }] },
          $select: [{ $fn: "count", $field: "*", $as: "t" }],
        },
      } as never)
      .catch((e: unknown) => e);
    expect(errorsOf(err)).toEqual((sdk as { errors: unknown[] }).errors);
  });

  it("an inner-only computed-$select issue keeps its code under the $from path", async () => {
    const err = await rejected(
      sales().query(
        "?$from=($groupBy=w&$select=bucket(createdAt,fortnight):w,count(*):n)&$select=sum(n):t",
      ),
    );
    expect(errorsOf(err)[0]).toMatchObject({ path: "$from.$select" });
  });

  it("an outer result column defined twice is AGG_NESTED_DUPLICATE_COLUMN", async () => {
    const err = await rejected(
      sales().query("?$from=($groupBy=region&$select=count(*):n)&$select=count(*):t,sum(n):t"),
    );
    expect(errorsOf(err)[0]).toMatchObject({
      path: "$select",
      code: "AGG_NESTED_DUPLICATE_COLUMN",
    });
  });

  it("every computed-$select issue of a one-level query keeps its code", async () => {
    const err = await rejected(
      sales().query("?$groupBy=region&$select=count(*):region,sum(amount):s,sum(cost):s"),
    );
    expect(bodyOf(err).code).toBe("INVALID_QUERY");
    expect(errorsOf(err)).toEqual([
      expect.objectContaining({ path: "$groupBy", code: "AGG_ALIAS_COLLISION" }),
      expect.objectContaining({ path: "$select", code: "AGG_ALIAS_COLLISION" }),
    ]);
  });

  it("an outer name that is a table field but no inner column is AGG_NESTED_UNKNOWN_COLUMN", async () => {
    const err = await rejected(
      sales().query("?$from=($groupBy=region&$select=count(*):n)&$select=sum(amount):t"),
    );
    expect(errorsOf(err)[0]).toMatchObject({ code: "AGG_NESTED_UNKNOWN_COLUMN" });
  });
});

describe("a permission layer", () => {
  it("sees the inner level through validateControls(…, 'nested')", async () => {
    const seen: Array<[TDbControlsType, unknown]> = [];
    class PolicyController extends AsDbController<any> {
      protected override validateControls(
        controls: Record<string, unknown>,
        type: TDbControlsType,
      ) {
        seen.push([type, controls.$groupBy]);
        // a $groupBy whitelist: only `region`
        const groupBy = (controls.$groupBy as string[] | undefined) ?? [];
        if (groupBy.some((g) => g !== "region"))
          return `Grouping by "${groupBy.join(",")}" is not allowed`;
        return super.validateControls(controls, type);
      }
    }
    const res = await sales(PolicyController).query(
      "?$from=($groupBy=region,customerId&$select=count(*):n)&$groupBy=region&$select=region,sum(n):t",
    );
    expect(res).toBeInstanceOf(HttpError);
    expect(bodyOf(res as HttpError).message).toBe('Grouping by "region,customerId" is not allowed');
    expect(seen).toEqual([
      ["query", ["region"]],
      ["nested", ["region", "customerId"]],
    ]);
  });

  it("an ARBAC-style control policy applies to the inner level too", async () => {
    // the shape of a role's `controls` policy: `false` refuses a control that is used
    // (an empty `$groupBy` counts — the ungrouped outer level of a `$from`)
    const policed = (policy: Record<string, boolean>) =>
      class extends AsDbController<any> {
        protected override validateControls(
          controls: Record<string, unknown>,
          type: TDbControlsType,
        ) {
          const base = super.validateControls(controls, type);
          if (base) return base;
          for (const [key, allowed] of Object.entries(policy)) {
            const used = controls[key];
            if (allowed || used === undefined || used === null) continue;
            if (Array.isArray(used) && used.length === 0 && key !== "$groupBy") continue;
            return `Control "${key}" is not allowed for your role`;
          }
          return undefined;
        }
      };
    const url = "?$from=($groupBy=region&$select=count(*):n&$having=n>0)&$select=sum(n):t";
    const noGroupBy = await sales(policed({ $groupBy: false }) as never).query(url);
    expect(bodyOf(noGroupBy as HttpError).message).toBe(
      'Control "$groupBy" is not allowed for your role',
    );
    // `$having` only in the inner level: the "nested" call refuses it
    const noHaving = await sales(policed({ $having: false }) as never).query(url);
    expect(bodyOf(noHaving as HttpError).message).toBe(
      'Control "$having" is not allowed for your role',
    );
    expect(
      await sales(policed({ $having: false }) as never).query(
        "?$from=($groupBy=region&$select=count(*):n)&$select=sum(n):t",
      ),
    ).toEqual([{ t: 5 }]);
  });

  it("turns $from off with nestedAggregates(), and /meta says so", async () => {
    class NoNested extends AsDbController<any> {
      protected override nestedAggregates(): boolean {
        return false;
      }
    }
    const err = await rejected(
      sales(NoNested).query("?$from=($groupBy=region&$select=count(*):n)&$select=sum(n):t"),
    );
    expect(bodyOf(err).code).toBe("AGG_NESTED_NOT_SUPPORTED");
    const meta = (await sales(NoNested).meta()) as TMetaResponse;
    expect(meta.nestedAggregates).toBe(false);
    // /meta lists no control the endpoint refuses
    expect(meta.crud?.query).not.toContain("from");
    const open = (await sales().meta()) as TMetaResponse;
    expect(open).toMatchObject({
      nestedAggregates: true,
      conditionalAggregates: true,
      distinctFieldLists: true,
    });
    expect(open.crud?.query).toContain("from");
  });
});

describe("fail closed where aggregates do not run", () => {
  it("an adapter without the features answers their codes", async () => {
    const mock = new DbSpace(() => new MockAdapter()).getTable(AlhSale);
    const ctrl = new AsDbController(createMockApp(), mock as never);
    for (const [url, code] of [
      ["?$from=($groupBy=region&$select=count(*):n)&$select=sum(n):t", "AGG_NESTED_NOT_SUPPORTED"],
      ["?$groupBy=region&$select=sum(amount|status=paid):p", "AGG_WHERE_NOT_SUPPORTED"],
      ["?$groupBy=region&$select=countDistinct(region,status):p", "AGG_FIELD_LIST_NOT_SUPPORTED"],
    ]) {
      const err = await rejected(ctrl.query(url));
      expect(bodyOf(err).code, url).toBe(code);
    }
    const meta = (await ctrl.meta()) as TMetaResponse;
    expect(meta).toMatchObject({
      nestedAggregates: false,
      conditionalAggregates: false,
      distinctFieldLists: false,
    });
  });

  it("/pages refuses $from, $where and field lists", async () => {
    for (const url of [
      "?$from=($groupBy=region&$select=count(*):n)",
      "?$select=sum(amount|status=paid):p",
      "?$select=countDistinct(region,status)",
    ]) {
      const err = await rejected(sales().pages(url));
      expect(bodyOf(err).message, url).toBe("Aggregate queries are only valid on /query");
    }
  });

  it("a $from inside $with does not parse", async () => {
    const err = await sales()
      .query("?$with=x($from=($groupBy=region))")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).body.statusCode).toBe(400);
    expect(JSON.stringify((err as HttpError).body)).toMatch(
      /\$from is only valid at the top level/,
    );
  });

  it("an unknown $-control on the aggregate path is a 400, not ignored", async () => {
    for (const url of [
      "?$groupBy=region&$select=region,count(*):n&$fuzzy=1",
      "?$select=count(*):n&$threshold=0.5",
      "?$from=($groupBy=region&$select=count(*):n)&$select=sum(n):t&$page=2",
    ]) {
      const res = await sales().query(url);
      expect(res, url).toBeInstanceOf(HttpError);
      expect(bodyOf(res as HttpError).message, url).toMatch(/^Unknown aggregate control "\$/);
    }
    // `$actions` asks for row actions grouped rows never carry: accepted, no effect
    expect(
      await sales().query("?$groupBy=region&$select=region&$sort=region&$actions=true"),
    ).toEqual([{ region: "N" }, { region: "S" }]);
  });

  it("value-help /query refuses $groupBy, $from and aggregates instead of ignoring them", async () => {
    const type = makeValueHelpType({
      props: {
        id: { designType: "string", annotations: { "meta.id": true } },
        label: { designType: "string" },
      },
    });
    const vh = new AsJsonValueHelpController(type, [{ id: "a", label: "A" }], createMockApp());
    for (const url of [
      "?$groupBy=label",
      "?$groupBy=label&$from=($groupBy=label)",
      "?$from=($groupBy=label&$select=count(*):n)",
      "?$select=count(*):n",
    ]) {
      const res = await vh.runQuery(url);
      expect(res, url).toBeInstanceOf(HttpError);
      expect((res as HttpError).body.statusCode, url).toBe(400);
    }
    expect(await vh.runQuery("?label=A")).toEqual([{ id: "a", label: "A" }]);
    // and its /meta lists no aggregate control
    const crud = (await vh.meta()).crud as { query?: string[] };
    for (const control of ["groupBy", "rowOrder", "from"]) {
      expect(crud.query).not.toContain(control);
    }
    expect(crud.query).toContain("filter");
  });
});
