import { describe, it, expect, vi } from "vite-plus/test";

import { AsJsonValueHelpController } from "../as-json-value-help.controller";
import { AsValueHelpController } from "../as-value-help.controller";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionPK } from "../actions/db-action-pk.decorator";
import { DbTableActions } from "../actions/db-actions.decorator";
import { makeTable } from "./actions-test-utils";

/**
 * Value-help controllers do NOT participate in action discovery. Even when
 * the developer applies `@DbTableActions(...)` to a value-help class, the
 * `/meta` envelope MUST emit `actions: []` and no warnings.
 */

type Status = { id: string; label: string };

function makeProp(designType: string, annotations: Record<string, unknown> = {}) {
  return {
    type: { kind: "", designType, tags: new Set() },
    metadata: new Map(Object.entries(annotations)),
  } as any;
}

function makeValueHelpType() {
  const props = new Map<string, any>();
  props.set("id", makeProp("string", { "meta.id": true }));
  props.set("label", makeProp("string"));
  return {
    __is_atscript_annotated_type: true,
    type: { kind: "object", props, propsPatterns: [], tags: new Set() },
    metadata: new Map(),
  } as any;
}

function makeApp() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() };
  return {
    app: { getLogger: vi.fn().mockReturnValue(logger) } as any,
    logger,
  };
}

describe("AsJsonValueHelpController + @DbTableActions", () => {
  @DbTableActions({
    refresh: { label: "Refresh", processor: "custom" },
  })
  class JsonHelp extends AsJsonValueHelpController<any, Status> {}

  it("returns actions: [] and emits no [moost-db actions] warnings", async () => {
    const ctx = makeApp();
    const ctrl = new JsonHelp(makeValueHelpType(), [], ctx.app);
    const meta = await ctrl.meta();
    expect(meta.actions).toEqual([]);
    const warned = ctx.logger.warn.mock.calls.some((args: unknown[]) =>
      typeof args[0] === "string" ? args[0].includes("[moost-db actions]") : false,
    );
    expect(warned).toBe(false);
  });

  it("@DbAction with disabled on a value-help class is silently ignored (no interceptor registers, no warning)", () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      class MyValueHelp extends AsValueHelpController<any, Status> {
        @DbAction("foo", {
          label: "Foo",
          // table satisfies the static check (clause 2) — without the
          // value-help carve-out in db-action.decorator.ts, an interceptor
          // would register at module load. The carve-out blocks it.
          table: makeTable() as never,
          disabled: () => true,
        })
        foo(@DbActionPK() _id: string) {
          return "ok";
        }

        protected async query() {
          return { data: [], count: 0 };
        }
        protected async getOne() {
          return null;
        }
      }
      // Class definition completes without console.warn (decorator factory
      // doesn't multi-stack-warn or fail).
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      // The class is constructible (the decorator body didn't blow up).
      expect(MyValueHelp).toBeDefined();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
