import { describe, it, expect } from "vite-plus/test";
import { getMoostMate } from "moost";

import { AsDbController } from "../as-db.controller";
import { AsDbReadableController } from "../as-db-readable.controller";
import { AsJsonValueHelpController } from "../as-json-value-help.controller";
import { AsValueHelpController } from "../as-value-help.controller";
import { DB_CRUD_HANDLERS, VALUE_HELP_CRUD_HANDLERS } from "../index";

/**
 * The exported CRUD op → handler-method maps (since 0.1.143) name real,
 * routed handler methods of each controller family — a permission layer
 * authorizes `/meta` `crud` entries through them, so they must not drift.
 */

function routedMethods(ctor: Function): Set<string> {
  const out = new Set<string>();
  const mate = getMoostMate();
  for (let proto = ctor.prototype; proto && proto !== Object.prototype; ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      if ((mate.read(proto, name) as { handlers?: unknown[] } | undefined)?.handlers?.length) {
        out.add(name);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return out;
}

describe("DB_CRUD_HANDLERS", () => {
  it("covers every CRUD op with routed AsDbController handlers", () => {
    const routed = routedMethods(AsDbController);
    expect(Object.keys(DB_CRUD_HANDLERS).toSorted()).toEqual(
      ["geo", "insert", "one", "pages", "query", "remove", "replace", "update"].toSorted(),
    );
    for (const methods of Object.values(DB_CRUD_HANDLERS)) {
      for (const m of methods) expect(routed, m).toContain(m);
    }
    expect(DB_CRUD_HANDLERS.one).toEqual(["getOne", "getOneComposite"]);
    expect(DB_CRUD_HANDLERS.remove).toEqual(["remove", "removeComposite"]);
  });

  it("the read ops are routed on a plain readable too; the write ops are not", () => {
    const routed = routedMethods(AsDbReadableController);
    for (const op of ["query", "pages", "one", "geo"] as const) {
      for (const m of DB_CRUD_HANDLERS[op]) expect(routed).toContain(m);
    }
    for (const op of ["insert", "update", "replace", "remove"] as const) {
      for (const m of DB_CRUD_HANDLERS[op]) expect(routed).not.toContain(m);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(DB_CRUD_HANDLERS)).toBe(true);
  });
});

describe("VALUE_HELP_CRUD_HANDLERS", () => {
  it("names the routed read handlers of both value-help controllers", () => {
    expect(Object.keys(VALUE_HELP_CRUD_HANDLERS).toSorted()).toEqual(["one", "pages", "query"]);
    for (const ctor of [AsValueHelpController, AsJsonValueHelpController]) {
      const routed = routedMethods(ctor);
      for (const methods of Object.values(VALUE_HELP_CRUD_HANDLERS)) {
        for (const m of methods!) expect(routed, m).toContain(m);
      }
    }
    expect(VALUE_HELP_CRUD_HANDLERS.one).toEqual(["runGetOne", "runGetOneComposite"]);
  });
});
