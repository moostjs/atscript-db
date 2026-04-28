import { describe, it, expect, vi } from "vite-plus/test";

import { AsJsonValueHelpController } from "../as-json-value-help.controller";
import { DbTableActions } from "../actions/db-actions.decorator";

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
});
