import { describe, it, expectTypeOf } from "vite-plus/test";

import type { AtscriptDbTable } from "../table/db-table";
import type { UsersTable } from "./fixtures/test-table.as";

// Since 0.1.165 `insertOne(row, { returning })` answers the stored row as `row`.

declare const users: AtscriptDbTable<typeof UsersTable>;

describe("insertOne returning — types", () => {
  it("answers a typed row with returning, none without", () => {
    if (Math.random() > 2) {
      const withRow = users.insertOne({} as never, { returning: true });
      expectTypeOf(withRow).resolves.toHaveProperty("row").toEqualTypeOf<UsersTable>();
      const plain = users.insertOne({} as never);
      expectTypeOf(plain).resolves.not.toHaveProperty("row");
      // @ts-expect-error unknown field in the returning list
      void users.insertOne({} as never, { returning: ["nope"] });
    }
  });
});
