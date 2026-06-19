/* eslint-disable unicorn/consistent-function-scoping */
import { describe, it, expect, vi } from "vite-plus/test";

import type { TDbActionEnvelope } from "../actions/discover";
import { augmentRowsWithActions } from "../actions/list-augmenter";

/**
 * Unit tests for the (now sync) list augmenter. The auto-dep-tracker is
 * gone — `requiredFields` drives all projection widening at the controller
 * level, so the augmenter assumes pre-widened rows and just evaluates each
 * `disabled` predicate, fans verdicts into per-row `$actions`, and strips
 * fields the caller didn't request.
 */

function fakeEnvelope(opts: {
  name: string;
  level?: "row" | "rows" | "table";
  processor?: TDbActionEnvelope["info"]["processor"];
  raw?: Record<string, unknown>;
}): TDbActionEnvelope {
  return {
    info: {
      name: opts.name,
      label: opts.name,
      level: opts.level ?? "row",
      processor: opts.processor ?? "backend",
      value: `/x/${opts.name}`,
    },
    raw: (opts.raw ?? {}) as never,
  };
}

describe("augmentRowsWithActions — basic flow", () => {
  it("no envelopes leaves rows untouched (caller-level no-op contract)", () => {
    const out = augmentRowsWithActions({
      envelopes: [],
      rows: [{ id: 1, name: "a" }],
      resolvedProjection: ["id", "name"],
    });
    expect(out[0]).not.toHaveProperty("$actions");
  });

  it("action without disabled is unconditionally present in $actions", () => {
    const env = fakeEnvelope({ name: "archive", level: "row", raw: {} });
    const out = augmentRowsWithActions({
      envelopes: [env],
      rows: [{ id: 1 }, { id: 2 }],
      resolvedProjection: ["id"],
    });
    expect(out[0].$actions).toEqual(["archive"]);
    expect(out[1].$actions).toEqual(["archive"]);
  });

  it("action with disabled returning [false] for some rows includes the action only there", () => {
    const env = fakeEnvelope({
      name: "approve",
      level: "row",
      raw: {
        requiredFields: ["state"],
        disabled: (rows: { state: string }[]) => rows.map((r) => r.state !== "pending"),
      },
    });
    const out = augmentRowsWithActions({
      envelopes: [env],
      rows: [
        { id: 1, state: "pending" },
        { id: 2, state: "approved" },
      ],
      resolvedProjection: ["id", "state"],
    });
    expect(out[0].$actions).toEqual(["approve"]);
    expect(out[1].$actions).toEqual([]);
  });

  it("ordering follows envelope order regardless of verdict polarity", () => {
    const a = fakeEnvelope({ name: "a", level: "row" });
    const b = fakeEnvelope({
      name: "b",
      level: "row",
      raw: {
        requiredFields: ["x"],
        disabled: (rows: { x: number }[]) => rows.map((r) => r.x === 0),
      },
    });
    const c = fakeEnvelope({ name: "c", level: "row" });
    const out = augmentRowsWithActions({
      envelopes: [a, b, c],
      rows: [{ id: 1, x: 1 }],
      resolvedProjection: ["id", "x"],
    });
    expect(out[0].$actions).toEqual(["a", "b", "c"]);
  });

  it("table-level envelopes are filtered out — augmenter is a no-op when no row/rows envelopes survive", () => {
    const env = fakeEnvelope({ name: "import", level: "table" });
    const out = augmentRowsWithActions({
      envelopes: [env],
      rows: [{ id: 1 }],
      resolvedProjection: ["id"],
    });
    expect(out[0]).not.toHaveProperty("$actions");
  });
});

describe("augmentRowsWithActions — field stripping", () => {
  it("strips fields declared in requiredFields but absent from caller projection", () => {
    const env = fakeEnvelope({
      name: "approve",
      level: "row",
      raw: {
        requiredFields: ["state"],
        disabled: (rows: { state: string }[]) => rows.map((r) => r.state !== "pending"),
      },
    });
    const out = augmentRowsWithActions({
      envelopes: [env],
      rows: [{ id: 1, state: "pending", name: "a" }],
      resolvedProjection: ["id", "name"],
    });
    expect(out[0]).not.toHaveProperty("state");
    expect(out[0].id).toBe(1);
    expect(out[0].name).toBe("a");
    expect(out[0].$actions).toEqual(["approve"]);
  });

  it("does not strip fields the caller explicitly requested", () => {
    const env = fakeEnvelope({
      name: "approve",
      level: "row",
      raw: {
        requiredFields: ["state"],
        disabled: (rows: { state: string }[]) => rows.map((r) => r.state !== "pending"),
      },
    });
    const out = augmentRowsWithActions({
      envelopes: [env],
      rows: [{ id: 1, state: "pending" }],
      resolvedProjection: ["id", "state"],
    });
    expect(out[0].state).toBe("pending");
  });

  it("no strip when resolvedProjection is null (caller asked for all fields)", () => {
    const env = fakeEnvelope({
      name: "approve",
      level: "row",
      raw: {
        requiredFields: ["state"],
        disabled: (rows: { state: string }[]) => rows.map((r) => r.state !== "pending"),
      },
    });
    const out = augmentRowsWithActions({
      envelopes: [env],
      rows: [{ id: 1, state: "pending", description: "x" }],
      resolvedProjection: null,
    });
    expect(out[0]).toHaveProperty("state");
    expect(out[0]).toHaveProperty("description");
  });

  it("preserves a field shared between requiredFields and the user projection", () => {
    const a = fakeEnvelope({
      name: "a",
      level: "row",
      raw: {
        requiredFields: ["state"],
        disabled: (rows: { state: string }[]) => rows.map((r) => r.state !== "x"),
      },
    });
    const b = fakeEnvelope({
      name: "b",
      level: "row",
      raw: {
        requiredFields: ["archived"],
        disabled: (rows: { archived: boolean }[]) => rows.map((r) => r.archived),
      },
    });
    const out = augmentRowsWithActions({
      envelopes: [a, b],
      rows: [{ id: 1, state: "x", archived: false }],
      resolvedProjection: ["id", "state"],
    });
    expect(out[0].state).toBe("x");
    expect(out[0]).not.toHaveProperty("archived");
  });
});

describe("augmentRowsWithActions — length mismatch", () => {
  it("buggy disabled returning the wrong-length array surfaces HTTP 500 with the action name", () => {
    const env = fakeEnvelope({
      name: "ship",
      level: "row",
      raw: { requiredFields: ["state"], disabled: () => [true] },
    });
    let caught: unknown;
    try {
      augmentRowsWithActions({
        envelopes: [env],
        rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
        resolvedProjection: ["id", "state"],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(String((caught as { body?: { message?: string } })?.body?.message ?? "")).toContain(
      "ship",
    );
  });
});

describe("augmentRowsWithActions — `'rows'`-level per-row availability", () => {
  it("'rows'-level action with disabled produces per-row verdicts in $actions", () => {
    const disabled = vi.fn((rows: { archived: boolean }[]) => rows.map((r) => r.archived));
    const env = fakeEnvelope({
      name: "archive",
      level: "rows",
      raw: { requiredFields: ["archived"], disabled },
    });
    const out = augmentRowsWithActions({
      envelopes: [env],
      rows: [
        { id: 1, archived: false },
        { id: 2, archived: true },
      ],
      resolvedProjection: null,
    });
    expect(out[0].$actions).toEqual(["archive"]);
    expect(out[1].$actions).toEqual([]);
    expect(disabled).toHaveBeenCalledTimes(1);
  });
});

describe("augmentRowsWithActions — processor-agnostic gating (vue-table client gate contract)", () => {
  // The augmenter keys candidacy on LEVEL only; `processor` must never change
  // the verdict. @atscript/vue-table now gates `navigate`/`custom` row/rows
  // actions by `$actions` exactly like `backend` ones (only the
  // client-synthesised `__remove` is exempt), so this contract is load-bearing
  // across the two repos: a gated custom/navigate action MUST appear in
  // `$actions` iff enabled, identically to a backend action.
  it("emits identical per-row $actions for a gated action regardless of processor", () => {
    const gate = (rows: { archived: boolean }[]) => rows.map((r) => r.archived);
    const mk = (name: string, processor: TDbActionEnvelope["info"]["processor"]) =>
      fakeEnvelope({
        name,
        level: "row",
        processor,
        raw: { requiredFields: ["archived"], disabled: gate },
      });
    const out = augmentRowsWithActions({
      envelopes: [
        mk("backendAct", "backend"),
        mk("navigateAct", "navigate"),
        mk("customAct", "custom"),
      ],
      rows: [
        { id: 1, archived: false }, // enabled for all three
        { id: 2, archived: true }, // disabled for all three
      ],
      resolvedProjection: null,
    });
    expect(out[0].$actions).toEqual(["backendAct", "navigateAct", "customAct"]);
    expect(out[1].$actions).toEqual([]);
  });

  it("includes an ungated navigate/custom action unconditionally (no disabled → always present)", () => {
    const out = augmentRowsWithActions({
      envelopes: [
        fakeEnvelope({ name: "open", level: "row", processor: "navigate" }),
        fakeEnvelope({ name: "exportCsv", level: "rows", processor: "custom" }),
      ],
      rows: [{ id: 1 }, { id: 2 }],
      resolvedProjection: ["id"],
    });
    expect(out[0].$actions).toEqual(["open", "exportCsv"]);
    expect(out[1].$actions).toEqual(["open", "exportCsv"]);
  });
});

describe("augmentRowsWithActions — Candidate memoization (per-envelope cache)", () => {
  it("derives the disabled fn from `e.raw` once; mutating `e.raw.disabled` after the first call is ignored", () => {
    const originalDisabled = vi.fn((rows: { state: string }[]) =>
      rows.map((r) => r.state === "blocked"),
    );
    const env = fakeEnvelope({
      name: "approve",
      level: "row",
      raw: { requiredFields: ["state"], disabled: originalDisabled },
    });

    const first = augmentRowsWithActions({
      envelopes: [env],
      rows: [{ id: 1, state: "blocked" }],
      resolvedProjection: ["id", "state"],
    });
    expect(first[0].$actions).toEqual([]);
    expect(originalDisabled).toHaveBeenCalledTimes(1);

    // Mutate `.raw.disabled` to a function that would invert the verdict —
    // the cached candidate must still hold the ORIGINAL fn ref, so the second
    // call's verdict mirrors the first call's behavior.
    const replacement = vi.fn((rows: { state: string }[]) =>
      rows.map((r) => r.state !== "blocked"),
    );
    (env.raw as { disabled: unknown }).disabled = replacement;

    const second = augmentRowsWithActions({
      envelopes: [env],
      rows: [{ id: 2, state: "blocked" }],
      resolvedProjection: ["id", "state"],
    });
    expect(second[0].$actions).toEqual([]);
    expect(originalDisabled).toHaveBeenCalledTimes(2);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("table-level envelopes are pinned in the cache as 'no candidate' so subsequent calls skip them", () => {
    const env = fakeEnvelope({ name: "import", level: "table" });
    const out1 = augmentRowsWithActions({
      envelopes: [env],
      rows: [{ id: 1 }],
      resolvedProjection: ["id"],
    });
    expect(out1[0]).not.toHaveProperty("$actions");

    // Even if the level were mutated (it isn't, but defensively), the cached
    // null sentinel keeps this envelope skipped — verifies the cache is live.
    (env.info as { level: unknown }).level = "row";
    const out2 = augmentRowsWithActions({
      envelopes: [env],
      rows: [{ id: 2 }],
      resolvedProjection: ["id"],
    });
    expect(out2[0]).not.toHaveProperty("$actions");
  });
});
