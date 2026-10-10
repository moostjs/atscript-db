import { describe, it, expect, beforeAll, afterAll, vi } from "vite-plus/test";
import { DbSpace } from "@atscript/db";
import { planSchema, syncSchema } from "@atscript/db/sync";

import { PostgresAdapter } from "../postgres-adapter";
import { PgDriver } from "../pg-driver";
import { prepareFixtures } from "./test-utils";
import { pgReachable, recreatePgDatabase, dropPgDatabase } from "./live-server";

// Live DDL against a real server is slow under the parallel workspace run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// Server-gated: runs against a live PostgreSQL when one is reachable, skips
// otherwise (CI has no server). Override the server with
// `ATSCRIPT_PG_TEST_URL` (an admin connection; the spec creates and drops its
// own `relfix_rel` database — the adapter's default schema is `public`).
//
// Covers `@db.column`-renamed FK / referenced / primary-key columns end to
// end (DDL, FK sync, relational predicates, self-referencing mutations,
// single-row mutations re-keyed on the primary key, native cascades) —
// since 0.1.147.

const DB = "relfix_rel";

const reachable = await pgReachable();

let fx: Record<string, any>;
let driver: PgDriver;
let space: DbSpace;

const t = (type: unknown): any => space.getTable(type as never);
const types = () => [
  fx.RfTeam,
  fx.RfTicket,
  fx.RfIssue,
  fx.RfLabel,
  fx.RfTicketLabel,
  fx.RfBoard,
  fx.RfCard,
  fx.RfMemo,
  fx.RfTag,
  fx.RfTagUse,
];

async function ids(type: unknown, filter: Record<string, unknown>, key = "id") {
  const rows = await t(type).findMany({ filter, controls: { $sort: { [key]: 1 } } });
  return rows.map((r: Record<string, unknown>) => r[key]);
}

describe.skipIf(!reachable)(
  "[postgres live] @db.column-renamed FKs + relational predicates",
  () => {
    beforeAll(async () => {
      await prepareFixtures();
      fx = await import("./fixtures/rel-filter-live.as");
      driver = new PgDriver({ connectionString: await recreatePgDatabase(DB) });
      space = new DbSpace(() => new PostgresAdapter(driver));
    });

    afterAll(async () => {
      await driver?.close();
      await dropPgDatabase(DB);
    });

    describe("schema sync", () => {
      it("creates every table (FKs over renamed columns included)", async () => {
        const result = await syncSchema(space, types());
        expect(result.status).toBe("synced");
        expect(result.entries.filter((e) => e.status === "error")).toEqual([]);
        expect(result.entries.every((e) => e.status === "create")).toBe(true);
      });

      it("FK constraints sit on the physical columns", async () => {
        const inbound = async (table: string) =>
          ((await space.getReferencingForeignKeys(table)) ?? [])
            .map((fk) => `${fk.table}(${fk.fields.join(",")})->(${fk.targetFields.join(",")})`)
            .toSorted();
        expect(await inbound("rf_tags")).toEqual(["rf_tag_uses(tag_ref)->(tag_code)"]);
        expect(await inbound("rf_tickets")).toEqual([
          "rf_issues(ticket_ref)->(key)",
          "rf_memos(ticket_ref)->(key)",
          "rf_ticket_labels(ticketKey)->(key)",
          "rf_tickets(parentKey)->(key)",
        ]);
        expect(await inbound("rf_teams")).toEqual(["rf_tickets(team_ref)->(id)"]);
        expect(await inbound("rf_boards")).toEqual([
          "rf_boards(parent_org,parentCode)->(board_org,code)",
          "rf_cards(card_org,boardCode)->(board_org,code)",
        ]);
      });

      it("a second sync is a no-op", async () => {
        expect((await syncSchema(space, types())).status).toBe("up-to-date");
        const plan = await planSchema(space, types(), { force: true });
        expect(
          plan.entries.filter((e) => e.status !== "in-sync").map((e) => [e.name, e.status]),
        ).toEqual([]);
        // FK sync against the live constraints changes nothing either
        for (const type of types()) {
          await t(type).getAdapter().syncForeignKeys();
        }
        expect(await space.getReferencingForeignKeys("rf_tags")).toHaveLength(1);
      });
    });

    describe("data", () => {
      beforeAll(async () => {
        await t(fx.RfTeam).insertMany([
          { id: "t1", name: "Core" },
          { id: "t2", name: "Web" },
        ]);
        const tickets = t(fx.RfTicket);
        await tickets.insertOne({ key: "K1", title: "Login", teamId: "t1", status: "open" });
        await tickets.insertOne({
          key: "K2",
          title: "Signup",
          teamId: "t1",
          status: "closed",
          parentKey: "K1",
        });
        await tickets.insertOne({
          key: "K3",
          title: "Dash",
          teamId: "t2",
          status: "open",
          parentKey: "K2",
        });
        await tickets.insertOne({ key: "K4", title: "Docs", status: "open" });
        await t(fx.RfIssue).insertMany([
          { id: 1, title: "crash", ticketKey: "K1" },
          { id: 2, title: "ui", ticketKey: "K2" },
          { id: 3, title: "crash again", ticketKey: "K3" },
          { id: 4, title: "orphan" },
        ]);
        await t(fx.RfLabel).insertMany([
          { id: 1, name: "bug" },
          { id: 2, name: "ui" },
        ]);
        await t(fx.RfTicketLabel).insertMany([
          { id: 1, ticketKey: "K1", labelId: 1, pinned: true },
          { id: 2, ticketKey: "K2", labelId: 2 },
        ]);
        const boards = t(fx.RfBoard);
        await boards.insertOne({ org: "o1", code: "b1", title: "Alpha" });
        await boards.insertOne({
          org: "o1",
          code: "b2",
          title: "Beta",
          parentOrg: "o1",
          parentCode: "b1",
        });
        await boards.insertOne({
          org: "o2",
          code: "b1",
          title: "Gamma",
          parentOrg: "o1",
          parentCode: "b2",
        });
        await boards.insertOne({ org: "o2", code: "b2", title: "Delta" });
        await boards.insertOne({ org: "o3", code: "b1", title: "Epsilon" });
        await t(fx.RfCard).insertMany([
          { id: 1, boardOrg: "o1", boardCode: "b1" },
          { id: 2, boardOrg: "o2", boardCode: "b2" },
          { id: 3 },
        ]);
        await t(fx.RfMemo).insertMany([
          { id: "m1", ticketKey: "K1" },
          { id: "m2", ticketKey: "K2" },
          { id: "m3" },
        ]);
        await t(fx.RfTag).insertMany([
          { code: "a", label: "Alpha" },
          { code: "b", label: "Beta" },
          { code: "c", label: "Gamma" },
        ]);
        await t(fx.RfTagUse).insertMany([
          { id: 1, tagCode: "a", note: "x" },
          { id: 2, tagCode: "a", note: "y" },
          { id: 3, tagCode: "b", note: "y" },
          { id: 4, note: "x" },
        ]);
      });

      it("to: over a renamed FK column (as-test case 16 shape)", async () => {
        expect(await ids(fx.RfMemo, { ticket: { $some: { status: "open" } } })).toEqual(["m1"]);
        expect(await ids(fx.RfMemo, { ticket: { $none: {} } })).toEqual(["m3"]);
        expect(
          await ids(fx.RfIssue, { ticket: { $some: { teamId: { $in: ["t1"] }, status: "open" } } }),
        ).toEqual([1]);
        expect(await ids(fx.RfIssue, { ticket: { $none: { status: "open" } } })).toEqual([2, 4]);
      });

      it("from / via / two hops", async () => {
        const keys = (filter: Record<string, unknown>) => ids(fx.RfTicket, filter, "key");
        expect(
          await keys({ issues: { $some: { title: { $in: ["crash", "crash again"] } } } }),
        ).toEqual(["K1", "K3"]);
        expect(await keys({ issues: { $none: {} } })).toEqual(["K4"]);
        expect(await keys({ labels: { $some: { name: "bug" } } })).toEqual(["K1"]);
        expect(await keys({ labels: { $none: {} } })).toEqual(["K3", "K4"]);
        expect(
          await ids(fx.RfIssue, { ticket: { $some: { team: { $some: { name: "Web" } } } } }),
        ).toEqual([3]);
        expect(await ids(fx.RfTag, { uses: { $some: { note: "y" } } }, "code")).toEqual(["a", "b"]);
        expect(await ids(fx.RfTag, { uses: { $none: {} } }, "code")).toEqual(["c"]);
        expect(await ids(fx.RfTagUse, { tag: { $some: { label: "Beta" } } })).toEqual([3]);
      });

      it("composite FK with renamed parts", async () => {
        expect(await ids(fx.RfCard, { board: { $some: { title: "Alpha" } } })).toEqual([1]);
        expect(await ids(fx.RfCard, { board: { $none: {} } })).toEqual([3]);
        expect(
          (await t(fx.RfBoard).findMany({ filter: { parentBoard: { $some: {} } }, controls: {} }))
            .map((r: any) => r.title)
            .toSorted(),
        ).toEqual(["Beta", "Gamma"]);
      });

      it("self-referencing updateMany and composite deleteMany", async () => {
        const upd = await t(fx.RfTicket).updateMany(
          { parent: { $some: { status: "open" } } },
          { title: "child of open" },
        );
        expect(upd.modifiedCount).toBe(1);
        expect((await t(fx.RfTicket).findById("K2")).title).toBe("child of open");
        const del = await t(fx.RfBoard).deleteMany({ parentBoard: { $some: { title: "Beta" } } });
        expect(del.deletedCount).toBe(1);
        expect(
          (await t(fx.RfBoard).findMany({ filter: {}, controls: {} }))
            .map((r: any) => r.title)
            .toSorted(),
        ).toEqual(["Alpha", "Beta", "Delta", "Epsilon"]);
      });

      it("updateOne / deleteOne on renamed primary keys (single + composite)", async () => {
        expect((await t(fx.RfTag).updateOne({ code: "c", label: "Gamma 2" })).modifiedCount).toBe(
          1,
        );
        expect((await t(fx.RfTag).findById("c")).label).toBe("Gamma 2");
        expect((await t(fx.RfTag).deleteOne("c")).deletedCount).toBe(1);
        const boards = t(fx.RfBoard);
        expect(
          (await boards.updateOne({ org: "o2", code: "b2", title: "Delta 2" })).modifiedCount,
        ).toBe(1);
        expect((await boards.findById({ org: "o2", code: "b2" })).title).toBe("Delta 2");
        expect((await boards.deleteOne({ org: "o3", code: "b1" })).deletedCount).toBe(1);
        expect(await boards.findById({ org: "o3", code: "b1" })).toBeNull();
      });

      it("deleteMany by a $some predicate cascades natively to the children", async () => {
        const res = await t(fx.RfTag).deleteMany({ uses: { $some: { note: "x" } } });
        expect(res.deletedCount).toBe(1);
        expect(await ids(fx.RfTag, {}, "code")).toEqual(["b"]);
        expect(await ids(fx.RfTagUse, {})).toEqual([3, 4]);
      });
    });
  },
);
