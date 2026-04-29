import { describe, it, expect, vi } from "vite-plus/test";
import type { TMetaResponse } from "@atscript/db";

import { AsDbController } from "../as-db.controller";
import { makeApp, makeTable } from "./actions-test-utils";

function instantiate(Ctor: typeof AsDbController): AsDbController {
  return new Ctor(makeTable() as never, makeApp().app);
}

describe("AsReadableController — applyMetaOverlay", () => {
  it("default overlay is a no-op: meta() returns the cached envelope by reference", async () => {
    const ctrl = instantiate(AsDbController);
    const a = await ctrl.meta();
    const b = await ctrl.meta();
    expect(a).toBe(b);
    expect(a).toEqual(b);
  });

  it("overlay is invoked once per meta() call; static envelope is built only once", async () => {
    const buildSpy = vi.fn();
    const overlaySpy = vi.fn();

    class Ctrl extends AsDbController {
      protected override buildMetaResponse(): TMetaResponse {
        buildSpy();
        return super.buildMetaResponse();
      }
      protected override applyMetaOverlay(meta: TMetaResponse): TMetaResponse {
        overlaySpy();
        return meta;
      }
    }

    const ctrl = instantiate(Ctrl as unknown as typeof AsDbController);
    await ctrl.meta();
    await ctrl.meta();
    await ctrl.meta();

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(overlaySpy).toHaveBeenCalledTimes(3);
  });

  it("overlay deleting a crud key MUST NOT mutate the cached envelope", async () => {
    class Ctrl extends AsDbController {
      protected override applyMetaOverlay(meta: TMetaResponse): TMetaResponse {
        // Correct usage: shallow-clone before pruning — must not touch `meta`.
        const next = { ...meta, crud: { ...meta.crud } };
        delete next.crud.remove;
        return next;
      }
    }

    const ctrl = instantiate(Ctrl as unknown as typeof AsDbController);
    const r1 = await ctrl.meta();
    const r2 = await ctrl.meta();

    expect(r1.crud.remove).toBeUndefined();
    expect(r2.crud.remove).toBeUndefined();

    const cached = (ctrl as unknown as { _metaResponse?: TMetaResponse })._metaResponse;
    expect(cached?.crud.remove).toEqual([]);
  });

  it("overlay may filter actions[] and the filtered set is returned on each call", async () => {
    class Ctrl extends AsDbController {
      protected override buildActions() {
        return [
          {
            name: "block",
            label: "Block",
            level: "row" as const,
            processor: "custom" as const,
            value: "block",
          },
          {
            name: "lock",
            label: "Lock",
            level: "row" as const,
            processor: "custom" as const,
            value: "lock",
          },
        ];
      }
      protected override applyMetaOverlay(meta: TMetaResponse): TMetaResponse {
        return { ...meta, actions: meta.actions.filter((a) => a.name === "block") };
      }
    }

    const ctrl = instantiate(Ctrl as unknown as typeof AsDbController);
    const r1 = await ctrl.meta();
    const r2 = await ctrl.meta();

    expect(r1.actions.map((a) => a.name)).toEqual(["block"]);
    expect(r2.actions.map((a) => a.name)).toEqual(["block"]);
  });

  it("overlay may return a Promise that meta() awaits", async () => {
    class Ctrl extends AsDbController {
      protected override applyMetaOverlay(
        meta: TMetaResponse,
      ): TMetaResponse | Promise<TMetaResponse> {
        // Async overlay that prunes via rest-destructuring — the pattern
        // recommended by docs/http/permissions.md (one allocation, no
        // `delete`, doesn't violate the "no widening" contract).
        const { insert: _drop, ...crud } = meta.crud;
        return Promise.resolve({ ...meta, crud });
      }
    }

    const ctrl = instantiate(Ctrl as unknown as typeof AsDbController);
    const meta = await ctrl.meta();
    expect("insert" in meta.crud).toBe(false);
    expect(meta.crud.update).toEqual([]);
  });
});
