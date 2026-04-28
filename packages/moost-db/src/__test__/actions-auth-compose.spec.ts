import { describe, it, expect } from "vite-plus/test";
import { Label, getMoostMate } from "moost";
import { Post } from "@moostjs/event-http";

import { DbAction } from "../actions/db-action.decorator";
import { DbActionPK } from "../actions/db-action-pk.decorator";
import { MOOST_DB_ACTION, MOOST_DB_ACTION_PARAM } from "../actions/keys";

/**
 * `@DbAction` writes to its own metadata key — composing it with the
 * surrounding Moost decorator surface (here: `@Post`, `@Label`, parameter
 * resolvers) MUST NOT clobber the existing entries. Auth guard short-circuit
 * behaviour is owned by Moost itself and is not re-tested here.
 */

describe("@DbAction composition with Moost decorators", () => {
  it("preserves @Post handler + @Label metadata when applied to the same method", () => {
    class Ctrl {
      @Post("actions/block")
      @Label("Block User")
      @DbAction("block", { icon: "i-as-block" })
      async block(@DbActionPK() id: string) {
        return id;
      }
    }
    const meta = getMoostMate().read(Ctrl.prototype, "block");
    expect(meta).toBeDefined();
    if (!meta) return;
    // @Post writes a handler entry into `handlers[]`.
    expect(meta.handlers?.[0]).toMatchObject({
      method: "POST",
      path: "actions/block",
      type: "HTTP",
    });
    // @Label survives.
    expect(meta.label).toBe("Block User");
    // @DbAction wrote the action entry.
    expect((meta as unknown as Record<string, unknown>)[MOOST_DB_ACTION]).toMatchObject({
      name: "block",
      opts: { icon: "i-as-block" },
    });
    // @DbActionPK marked the param.
    expect((meta.params?.[0] as unknown as Record<string, unknown>)?.[MOOST_DB_ACTION_PARAM]).toBe(
      "pk",
    );
  });
});
