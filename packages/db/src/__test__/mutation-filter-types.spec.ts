import { describe, it, expectTypeOf } from "vite-plus/test";

import type { AtscriptDbTable } from "../table/db-table";
import type { RfTicket } from "./fixtures/rel-filter.as";

// Since 0.1.165 the mutation filters (`updateMany`, `replaceMany`,
// `deleteMany`) take relational predicates on nav keys exactly like the read
// filter does. Before, `{ issues: { $some: … } }` failed to typecheck (the
// flat type's nav key is `never`), though it works at runtime.

declare const tickets: AtscriptDbTable<typeof RfTicket>;

type FilterOf<M extends "updateMany" | "replaceMany" | "deleteMany"> = Parameters<
  AtscriptDbTable<typeof RfTicket>[M]
>[0];

describe("mutation filter typing", () => {
  it("accepts $some / $none on nav keys", () => {
    const some = { issues: { $some: { title: "a" } } };
    const none = { $or: [{ team: { $none: { name: "x" } } }, { status: "open" }] };
    expectTypeOf(some).toMatchTypeOf<FilterOf<"deleteMany">>();
    expectTypeOf(none).toMatchTypeOf<FilterOf<"deleteMany">>();
    expectTypeOf(some).toMatchTypeOf<FilterOf<"updateMany">>();
    expectTypeOf(some).toMatchTypeOf<FilterOf<"replaceMany">>();
    if (Math.random() > 2) {
      void tickets.deleteMany({ issues: { $some: { title: "a" } } });
      void tickets.updateMany({ team: { $some: { name: "x" } } }, { status: "closed" });
    }
  });

  it("still checks own fields and their operators", () => {
    expectTypeOf({ status: { $in: ["open"] } }).toMatchTypeOf<FilterOf<"deleteMany">>();
    if (Math.random() > 2) {
      // @ts-expect-error unknown field
      void tickets.deleteMany({ nope: 1 });
    }
  });
});
