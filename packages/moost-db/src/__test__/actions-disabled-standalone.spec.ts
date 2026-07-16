import { describe, it, expect } from "vite-plus/test";
import { Moost } from "moost";

import { AsDbController } from "../as-db.controller";
import { AsDbReadableController } from "../as-db-readable.controller";
import { discoverActions } from "../actions/discover";
import { fakeOverview, makeApp, makeLogger, makeTable } from "./actions-test-utils";

/**
 * Coverage for the static-table check at discovery time. The check fires
 * for actions that declare `disabled` OR have a `@DbActionRow*` parameter.
 * It requires AT LEAST ONE of:
 *   1. controller class extends `AsDbReadableController` (covers
 *      `AsDbController` too), OR
 *   2. `opts.table` is set in decorator metadata.
 *
 * The duck-type instance-property fallback (`readable = ...`) is NOT visible
 * to discovery — gating requires explicit opt-in.
 */

describe("Discovery static-table check (non-AsDbController gating)", () => {
  it("plain @DbActionID without disabled or row-injection works without opts.table (duck-type at request time only)", () => {
    // A plain controller (no AsDbReadableController inheritance, no
    // disabled, no @DbActionRow*) — discovery does NOT probe the
    // duck-type. The action is emitted normally.
    class Plain {
      _tag = "Plain";
    }
    const logger = makeLogger();
    const app: any = {
      getLogger: () => logger,
      getControllersOverview: () => [
        fakeOverview(Plain, [
          {
            method: "act",
            httpMethod: "POST",
            path: "/c/act",
            action: { name: "act", opts: { label: "Act" } },
            paramKinds: ["id"],
          },
        ]),
      ],
    };
    const actions = discoverActions(Plain, app as Moost, logger);
    expect(actions).toHaveLength(1);
    expect(actions[0].info.name).toBe("act");
    // No warning about missing table.
    const warnedAboutTable = logger.warn.mock.calls.some((args: unknown[]) =>
      typeof args[0] === "string" ? args[0].includes("does not extend") : false,
    );
    expect(warnedAboutTable).toBe(false);
  });

  it("non-AsDbController + disabled WITHOUT opts.table — warning + dropped", () => {
    class Plain {
      _tag = "Plain";
    }
    const logger = makeLogger();
    const app: any = {
      getLogger: () => logger,
      getControllersOverview: () => [
        fakeOverview(Plain, [
          {
            method: "act",
            httpMethod: "POST",
            path: "/c/act",
            action: {
              name: "act",
              opts: { label: "Act", requiredFields: ["state"], disabled: () => [false] },
            },
            paramKinds: ["id"],
          },
        ]),
      ],
    };
    const actions = discoverActions(Plain, app as Moost, logger);
    expect(actions).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("does not extend AsDbReadableController"),
    );
  });

  it("non-AsDbController + disabled + opts.table — emitted", () => {
    class Plain {
      _tag = "Plain";
    }
    const logger = makeLogger();
    const app: any = {
      getLogger: () => logger,
      getControllersOverview: () => [
        fakeOverview(Plain, [
          {
            method: "act",
            httpMethod: "POST",
            path: "/c/act",
            action: {
              name: "act",
              opts: {
                label: "Act",
                requiredFields: ["state"],
                disabled: () => [false],
                table: makeTable() as never,
              },
            },
            paramKinds: ["id"],
          },
        ]),
      ],
    };
    const actions = discoverActions(Plain, app as Moost, logger);
    expect(actions).toHaveLength(1);
    expect(actions[0].info.name).toBe("act");
  });

  it("AsDbReadableController subclass + disabled (no opts.table) — passes static check", () => {
    class ReadOnly extends AsDbReadableController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(ReadOnly, [
        {
          method: "act",
          httpMethod: "POST",
          path: "/c/act",
          action: {
            name: "act",
            opts: { label: "Act", requiredFields: ["state"], disabled: () => [false] },
          },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new ReadOnly(ctx.app, makeTable() as never);
    return ctrl.meta().then((meta) => {
      expect(meta.actions).toHaveLength(1);
      expect(meta.actions[0].name).toBe("act");
    });
  });

  it("AsDbController + opts.table — opts.table is silently accepted (runtime ignores it; bound table wins)", async () => {
    class C extends AsDbController {}
    const ctx = makeApp();
    ctx.setOverview([
      fakeOverview(C, [
        {
          method: "act",
          httpMethod: "POST",
          path: "/c/act",
          action: {
            name: "act",
            opts: {
              label: "Act",
              requiredFields: ["state"],
              disabled: () => [false],
              // table forwarded into opts but the runtime instanceof
              // AsDbReadableController check makes the bound table win;
              // discovery doesn't warn about the redundancy.
              table: makeTable() as never,
            },
          },
          paramKinds: ["id"],
        },
      ]),
    ]);
    const ctrl = new C(ctx.app, makeTable() as never);
    const meta = await ctrl.meta();
    expect(meta.actions).toHaveLength(1);
    expect(ctx.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("does not extend"));
  });

  it("non-AsDbController + @DbActionRow without opts.table — dropped (row-injection requires opt-in)", () => {
    class Plain {
      _tag = "Plain";
    }
    const logger = makeLogger();
    const app: any = {
      getLogger: () => logger,
      getControllersOverview: () => [
        fakeOverview(Plain, [
          {
            method: "act",
            httpMethod: "POST",
            path: "/c/act",
            action: { name: "act", opts: { label: "Act" } },
            paramKinds: ["row"],
          },
        ]),
      ],
    };
    const actions = discoverActions(Plain, app as Moost, logger);
    expect(actions).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("does not extend AsDbReadableController"),
    );
  });
});
