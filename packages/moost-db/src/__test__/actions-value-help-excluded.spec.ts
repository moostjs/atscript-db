import { describe, it, expect, vi } from "vite-plus/test";
import { Inherit } from "moost";

import { AsJsonValueHelpController } from "../as-json-value-help.controller";
import { AsValueHelpController } from "../as-value-help.controller";
import { DbAction } from "../actions/db-action.decorator";
import { DbActionID } from "../actions/db-action-id.decorator";
import { DbRowActions, DbTableActions } from "../actions/db-actions.decorator";
import { makeTable } from "./actions-test-utils";

/**
 * Value-help controllers do NOT support actions (since 0.1.143 a hard
 * error): `@DbAction` / `@DbActions*` on a value-help class throws at
 * decoration, and an action inherited from a non-value-help base throws at
 * construction — before, the action was dropped from `/meta` while its
 * `@Post` route still ran with no gate.
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

describe("value-help controllers reject actions", () => {
  it("@DbTableActions / @DbRowActions on a value-help class throw at decoration", () => {
    expect(() => {
      @DbTableActions({ refresh: { label: "Refresh", processor: "custom" } })
      class JsonHelp extends AsJsonValueHelpController<any, Status> {}
      return JsonHelp;
    }).toThrow(/JsonHelp is a value-help controller .*"refresh"/);
    expect(() => {
      @DbRowActions({ open: { label: "Open", processor: "navigate", value: "/x/$1" } })
      class RowHelp extends AsJsonValueHelpController<any, Status> {}
      return RowHelp;
    }).toThrow(/value-help controller/);
  });

  it("@DbAction on a value-help method throws at decoration (with or without a gate)", () => {
    expect(() => {
      class MyValueHelp extends AsValueHelpController<any, Status> {
        @DbAction("foo", {
          label: "Foo",
          table: makeTable() as never,
          disabled: () => [true],
        })
        foo(@DbActionID() _id: string) {
          return "ok";
        }

        protected async query() {
          return { data: [], count: 0 };
        }
        protected async getOne() {
          return null;
        }
      }
      return MyValueHelp;
    }).toThrow(/MyValueHelp is a value-help controller .*"foo"/);
    expect(() => {
      class Plain extends AsJsonValueHelpController<any, Status> {
        @DbAction("bar", { label: "Bar" })
        bar() {
          return "ok";
        }
      }
      return Plain;
    }).toThrow(/"bar"/);
  });

  it("an action inherited from a non-value-help base throws at construction", () => {
    @Inherit()
    class Mixin {
      @DbAction("inherited", { label: "Inherited" })
      inherited() {
        return "ok";
      }
    }
    // A non-value-help mixin spliced between the value-help base and the class.
    class Mixed extends AsJsonValueHelpController<any, Status> {}
    Object.setPrototypeOf(Mixin.prototype, AsJsonValueHelpController.prototype);
    Object.setPrototypeOf(Mixed.prototype, Mixin.prototype);
    expect(() => new Mixed(makeValueHelpType(), [], makeApp().app)).toThrow(
      /Mixed is a value-help controller .*"inherited"/,
    );
  });

  it("a value-help controller without actions constructs and emits actions: []", async () => {
    const ctx = makeApp();
    class JsonHelp extends AsJsonValueHelpController<any, Status> {}
    const ctrl = new JsonHelp(makeValueHelpType(), [], ctx.app);
    expect((await ctrl.meta()).actions).toEqual([]);
  });
});
