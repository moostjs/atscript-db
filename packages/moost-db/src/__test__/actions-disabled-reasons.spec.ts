import { describe, it, expect, expectTypeOf } from "vite-plus/test";
import { current } from "@wooksjs/event-core";

import {
  ActionDisabledError,
  type ActionDisabledErrorBody,
} from "../actions/action-disabled-error";
import { buildGateInterceptor } from "../actions/gate-interceptor";
import { dbActionIdsSlot } from "../actions/id-cache";
import type { TDbActionEnvelope } from "../actions/discover";
import { augmentRowsWithActions } from "../actions/list-augmenter";
import { perRow } from "../actions/per-row";
import { dbActionRowsSlot } from "../actions/row-cache";
import type { DbActionOpts, TDbActionDisabledVerdict, TOnDisabledRows } from "../actions/types";
import {
  bindController,
  makeOpsTable,
  runBeforeInterceptor,
  runInActionCtx,
  setBoundTable,
  setupActionMeta,
} from "./actions-test-utils";

/**
 * `disabled` predicates may return, per row, `boolean | string` — a
 * non-empty string disables the action AND carries a reason. Reasons reach
 * the 409 body (`reason` / `reasons`) and the read augmentation
 * (`$disabledReasons`); boolean predicates behave exactly as before.
 */

type Row = { id: string; status: string };

const reasonFor = (rows: unknown[]): TDbActionDisabledVerdict[] =>
  (rows as Row[]).map((r) => {
    if (r.status === "shipped") return "Order already shipped";
    if (r.status === "cancelled") return "Order was cancelled";
    return r.status === "locked";
  });

async function runGate(opts: {
  level: "row" | "rows";
  rows: Row[];
  body: string;
  disabled: (rows: unknown[]) => TDbActionDisabledVerdict[];
  onDisabledRows?: TOnDisabledRows;
}): Promise<{ caught: unknown; ids?: unknown[]; rows?: unknown[] }> {
  const table = makeOpsTable(opts.rows);
  class Ctrl {
    act(): void {}
  }
  setupActionMeta(Ctrl, "act", { name: "act" }, [opts.level === "row" ? "id" : "ids"]);
  const def = buildGateInterceptor({
    action: "act",
    level: opts.level,
    disabled: opts.disabled,
    onDisabledRows: opts.onDisabledRows ?? "reject",
  });
  const out: { caught: unknown; ids?: unknown[]; rows?: unknown[] } = { caught: undefined };
  await runInActionCtx(opts.body, async () => {
    bindController(new Ctrl(), "act");
    setBoundTable(table);
    try {
      await runBeforeInterceptor(def);
      if (opts.level === "rows") {
        const ctx = current();
        out.ids = (await ctx.get(dbActionIdsSlot)) as unknown[];
        out.rows = (await ctx.get(dbActionRowsSlot)) as unknown[];
      }
    } catch (e) {
      out.caught = e;
    }
  });
  return out;
}

function bodyOf(caught: unknown): ActionDisabledErrorBody {
  expect(caught).toBeInstanceOf(ActionDisabledError);
  return (caught as ActionDisabledError).body as unknown as ActionDisabledErrorBody;
}

describe("ActionDisabledError — reasons in the wire body", () => {
  it("row level with a reason: message = reason, body.reason set", () => {
    const body = bodyOf(
      new ActionDisabledError("ship", { id: 1 }, undefined, ["Order already shipped"]),
    );
    expect(body.message).toBe("Order already shipped");
    expect(body.reason).toBe("Order already shipped");
    expect(body.id).toEqual({ id: 1 });
    expect(body).not.toHaveProperty("reasons");
  });

  it("row level with an empty / missing reason keeps the generic message and no reason field", () => {
    for (const reasons of [undefined, [undefined], [""], [null]]) {
      const body = bodyOf(new ActionDisabledError("ship", { id: 1 }, undefined, reasons));
      expect(body.message).toBe('Action "ship" is disabled for this row');
      expect(body).not.toHaveProperty("reason");
      expect(body).not.toHaveProperty("reasons");
    }
  });

  it("rows level with one shared reason: message = reason, reason + aligned reasons", () => {
    const body = bodyOf(
      new ActionDisabledError("archive", undefined, [{ id: 1 }, { id: 2 }], ["X", "X"]),
    );
    expect(body.message).toBe("X");
    expect(body.reason).toBe("X");
    expect(body.reasons).toEqual(["X", "X"]);
  });

  it("rows level with mixed reasons: generic message + distinct reasons, no shared reason", () => {
    const body = bodyOf(
      new ActionDisabledError(
        "archive",
        undefined,
        [{ id: 1 }, { id: 2 }, { id: 3 }],
        ["A", undefined, "B"],
      ),
    );
    expect(body.message).toBe('Action "archive" is disabled for 3 of the selected rows: A; B');
    expect(body).not.toHaveProperty("reason");
    expect(body.reasons).toEqual(["A", null, "B"]);
  });

  it("rows level caps the distinct reasons quoted in the message", () => {
    const ids = [1, 2, 3, 4, 5].map((id) => ({ id }));
    const body = bodyOf(
      new ActionDisabledError("archive", undefined, ids, ["a", "b", "c", "d", "e"]),
    );
    expect(body.message).toBe(
      'Action "archive" is disabled for 5 of the selected rows: a; b; c (+2 more)',
    );
  });

  it("rows level without reasons is unchanged (no reason / reasons fields)", () => {
    const body = bodyOf(new ActionDisabledError("archive", undefined, [{ id: 1 }], [undefined]));
    expect(body.message).toBe('Action "archive" is disabled for 1 of the selected rows');
    expect(body).not.toHaveProperty("reason");
    expect(body).not.toHaveProperty("reasons");
  });
});

describe("Gate interceptor — reasons", () => {
  it("row level: string verdict → 409 with the reason as message", async () => {
    const { caught } = await runGate({
      level: "row",
      rows: [{ id: "a", status: "shipped" }],
      body: '{"ids":{"id":"a"}}',
      disabled: reasonFor,
    });
    const body = bodyOf(caught);
    expect(body.message).toBe("Order already shipped");
    expect(body.reason).toBe("Order already shipped");
    expect(body.id).toEqual({ id: "a" });
  });

  it("row level: `true` verdict → generic message, no reason", async () => {
    const { caught } = await runGate({
      level: "row",
      rows: [{ id: "a", status: "locked" }],
      body: '{"ids":{"id":"a"}}',
      disabled: reasonFor,
    });
    const body = bodyOf(caught);
    expect(body.message).toBe('Action "act" is disabled for this row');
    expect(body).not.toHaveProperty("reason");
  });

  it("row level: empty-string verdict is falsy → enabled", async () => {
    const { caught } = await runGate({
      level: "row",
      rows: [{ id: "a", status: "open" }],
      body: '{"ids":{"id":"a"}}',
      disabled: (rows) => rows.map(() => ""),
    });
    expect(caught).toBeUndefined();
  });

  it("rows reject: reasons aligned with failing ids (null for reason-less and missing rows)", async () => {
    const { caught } = await runGate({
      level: "rows",
      rows: [
        { id: "1", status: "open" },
        { id: "2", status: "shipped" },
        { id: "3", status: "locked" },
        { id: "4", status: "cancelled" },
      ],
      body: '{"ids":[{"id":"1"},{"id":"2"},{"id":"3"},{"id":"9"},{"id":"4"}]}',
      disabled: reasonFor,
    });
    const body = bodyOf(caught);
    expect(body.ids).toEqual([{ id: "2" }, { id: "3" }, { id: "9" }, { id: "4" }]);
    expect(body.reasons).toEqual(["Order already shipped", null, null, "Order was cancelled"]);
    expect(body).not.toHaveProperty("reason");
    expect(body.message).toBe(
      'Action "act" is disabled for 4 of the selected rows: Order already shipped; Order was cancelled',
    );
  });

  it("rows reject: a single failing row with a reason → message = reason", async () => {
    const { caught } = await runGate({
      level: "rows",
      rows: [
        { id: "1", status: "open" },
        { id: "2", status: "shipped" },
      ],
      body: '{"ids":[{"id":"1"},{"id":"2"}]}',
      disabled: reasonFor,
    });
    const body = bodyOf(caught);
    expect(body.ids).toEqual([{ id: "2" }]);
    expect(body.reason).toBe("Order already shipped");
    expect(body.reasons).toEqual(["Order already shipped"]);
    expect(body.message).toBe("Order already shipped");
  });

  it("rows reject: boolean predicate → body unchanged (no reason fields)", async () => {
    const { caught } = await runGate({
      level: "rows",
      rows: [
        { id: "1", status: "open" },
        { id: "2", status: "shipped" },
      ],
      body: '{"ids":[{"id":"1"},{"id":"2"}]}',
      disabled: (rows) => (rows as Row[]).map((r) => r.status === "shipped"),
    });
    const body = bodyOf(caught);
    expect(body.message).toBe('Action "act" is disabled for 1 of the selected rows');
    expect(body).not.toHaveProperty("reason");
    expect(body).not.toHaveProperty("reasons");
  });

  it("rows skip: rows disabled with a reason are dropped like `true` ones", async () => {
    const out = await runGate({
      level: "rows",
      rows: [
        { id: "1", status: "open" },
        { id: "2", status: "shipped" },
        { id: "3", status: "locked" },
      ],
      body: '{"ids":[{"id":"1"},{"id":"2"},{"id":"3"}]}',
      disabled: reasonFor,
      onDisabledRows: "skip",
    });
    expect(out.caught).toBeUndefined();
    expect(out.ids).toEqual([{ id: "1" }]);
    expect(out.rows).toEqual([{ id: "1", status: "open" }]);
  });

  it("rows skip, zero survivors: reasons aligned with ALL request ids", async () => {
    const { caught } = await runGate({
      level: "rows",
      rows: [
        { id: "1", status: "shipped" },
        { id: "2", status: "shipped" },
      ],
      body: '{"ids":[{"id":"1"},{"id":"2"}]}',
      disabled: reasonFor,
      onDisabledRows: "skip",
    });
    const body = bodyOf(caught);
    expect(body.ids).toEqual([{ id: "1" }, { id: "2" }]);
    expect(body.reasons).toEqual(["Order already shipped", "Order already shipped"]);
    expect(body.reason).toBe("Order already shipped");
    expect(body.message).toBe("Order already shipped");
  });
});

function fakeEnvelope(name: string, raw: Record<string, unknown> = {}): TDbActionEnvelope {
  return {
    info: { name, label: name, level: "row", processor: "backend", value: `/x/${name}` },
    raw: raw as never,
  };
}

describe("augmentRowsWithActions — $disabledReasons", () => {
  const ship = fakeEnvelope("ship", { requiredFields: ["status"], disabled: reasonFor });
  const edit = fakeEnvelope("edit");

  it("adds $disabledReasons only on rows with at least one reason", () => {
    const out = augmentRowsWithActions({
      envelopes: [edit, ship],
      rows: [
        { id: "1", status: "open" },
        { id: "2", status: "shipped" },
        { id: "3", status: "locked" },
      ],
      resolvedProjection: null,
    });
    expect(out[0].$actions).toEqual(["edit", "ship"]);
    expect(out[0]).not.toHaveProperty("$disabledReasons");
    expect(out[1].$actions).toEqual(["edit"]);
    expect(out[1].$disabledReasons).toEqual({ ship: "Order already shipped" });
    // `true` without a reason: hidden from $actions, absent from $disabledReasons.
    expect(out[2].$actions).toEqual(["edit"]);
    expect(out[2]).not.toHaveProperty("$disabledReasons");
  });

  it("collects reasons from several actions on the same row", () => {
    const archive = fakeEnvelope("archive", {
      requiredFields: ["status"],
      disabled: (rows: Row[]) => rows.map(() => "Archiving is paused"),
    });
    const out = augmentRowsWithActions({
      envelopes: [ship, archive],
      rows: [{ id: "2", status: "shipped" }],
      resolvedProjection: null,
    });
    expect(out[0].$actions).toEqual([]);
    expect(out[0].$disabledReasons).toEqual({
      ship: "Order already shipped",
      archive: "Archiving is paused",
    });
  });

  it("boolean predicates never produce $disabledReasons", () => {
    const flag = fakeEnvelope("flag", {
      requiredFields: ["status"],
      disabled: (rows: Row[]) => rows.map(() => true),
    });
    const out = augmentRowsWithActions({
      envelopes: [flag],
      rows: [{ id: "1", status: "open" }],
      resolvedProjection: ["id"],
    });
    expect(out[0].$actions).toEqual([]);
    expect(out[0]).not.toHaveProperty("$disabledReasons");
    expect(out[0]).not.toHaveProperty("status"); // requiredFields still stripped
  });
});

describe("perRow + typing", () => {
  it("perRow lifts string verdicts", () => {
    const lifted = perRow<Row>((r) => (r.status === "shipped" ? "Shipped" : false));
    expect(
      lifted([
        { id: "1", status: "shipped" },
        { id: "2", status: "open" },
      ]),
    ).toEqual(["Shipped", false]);
  });

  it("requiredFields-narrowed `disabled` accepts string verdicts", () => {
    // `FlatOf<T>` reads the `__flat` brand compiled `.as` types carry.
    type Order = { __flat: { id: number; status: string; total: number } };
    const opts: DbActionOpts<Order, ["status"]> = {
      requiredFields: ["status"],
      disabled: (rows) => rows.map((r) => (r.status === "shipped" ? "Already shipped" : false)),
    };
    expect(opts).toBeDefined();
    const bad: DbActionOpts<Order, ["status"]> = {
      requiredFields: ["status"],
      // @ts-expect-error `total` is not in requiredFields
      disabled: (rows) => rows.map((r) => (r.total > 0 ? "x" : false)),
    };
    expect(bad).toBeDefined();
    expectTypeOf<ReturnType<NonNullable<DbActionOpts["disabled"]>>>().toEqualTypeOf<
      (boolean | string)[]
    >();
  });
});
