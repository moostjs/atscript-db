/* eslint-disable @typescript-eslint/no-extraneous-class -- decorated test containers */
import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace, type DbQuery, type TResolvedWith } from "@atscript/db";
import { MemoryAdapter } from "@atscript/db-memory";
import { Inherit, getMoostInfact } from "moost";

import { AsDbController } from "../as-db.controller";
import { TableController } from "../decorators";
import { bootHttp, prepareFixtures, type THttpSend } from "./test-utils";

/**
 * An adapter that reads relations inside the read (since 0.1.196) behind a
 * controller: what a `validateControls` override conjoins into a `$with`
 * entry (a row scope, a narrower `$select`) reaches the entry the adapter
 * receives; `/meta` offers `relations[].filterable` only when the adapter
 * renders relational predicates, and serves a `@db.rel.store` navigation
 * with `direction: "store"`.
 */

/** Records each read's `$with` entries; answers every relation empty. */
class InReadMemoryAdapter extends MemoryAdapter {
  static entries: TResolvedWith[][] = [];

  override supportsWithInRead(): boolean {
    return true;
  }

  override async findManyWithCount(query: DbQuery) {
    const entries = query.controls.$with ?? [];
    if (entries.length > 0) InReadMemoryAdapter.entries.push(entries);
    const result = await super.findManyWithCount({
      ...query,
      controls: { ...query.controls, $with: undefined },
    });
    const data = result.data.map((row) => {
      const out: Record<string, unknown> = { ...row };
      for (const entry of entries) out[entry.nav] = entry.isArray ? [] : null;
      return out;
    });
    return { data, count: result.count };
  }
}

class NoPredicatesMemoryAdapter extends MemoryAdapter {
  override supportsRelationFilters(): boolean {
    return false;
  }
}

let send: THttpSend;
let SEQ = 0;
let scoped = "";
let plain = "";
let projects = "";
let included = "";
let excluded = "";

/**
 * An auth layer's field restriction on the depth-2 entry `members.team`: an
 * OBJECT `$select` (inclusion, or exclusion expanded to the leaves).
 */
function selectTeam(controls: Record<string, unknown>, select: Record<string, 0 | 1>) {
  for (const entry of (controls.$with ?? []) as Array<Record<string, any>>) {
    for (const inner of (entry.controls?.$with ?? []) as Array<Record<string, any>>) {
      if (inner.name === "team") inner.controls = { ...inner.controls, $select: select };
    }
  }
}

beforeAll(async () => {
  await prepareFixtures();
  const { WmTeam, WmProject } = await import("./fixtures/with-in-read.as");
  getMoostInfact()._cleanup();
  const teams = new DbSpace(() => new InReadMemoryAdapter()).getTable(WmTeam);
  await teams.insertOne({ id: 1, name: "Core" });
  const other = new DbSpace(() => new NoPredicatesMemoryAdapter()).getTable(WmTeam);
  const projectTable = new DbSpace(() => new InReadMemoryAdapter()).getTable(WmProject);
  scoped = `wm${++SEQ}`;
  plain = `wm${++SEQ}`;
  projects = `wm${++SEQ}`;
  included = `wm${++SEQ}`;
  excluded = `wm${++SEQ}`;

  @TableController(teams, scoped)
  @Inherit()
  class ScopedTeams extends AsDbController {
    // A permission layer: the related table's row scope and readable fields.
    protected override validateControls(controls: Record<string, unknown>, type: any) {
      const error = super.validateControls(controls, type);
      if (error) return error;
      for (const entry of (controls.$with ?? []) as Array<Record<string, any>>) {
        if (entry.name !== "members") continue;
        const scope = { role: "staff" };
        entry.filter = entry.filter ? { $and: [scope, entry.filter] } : scope;
        entry.controls = { ...entry.controls, $select: ["id", "name"] };
      }
      return undefined;
    }
  }

  @TableController(other, plain)
  @Inherit()
  class PlainTeams extends AsDbController {}

  @TableController(projectTable, projects)
  @Inherit()
  class Projects extends AsDbController {}

  @TableController(teams, included)
  @Inherit()
  class IncludedTeams extends AsDbController {
    protected override validateControls(controls: Record<string, unknown>, type: any) {
      const error = super.validateControls(controls, type);
      if (!error) selectTeam(controls, { id: 1, name: 1 });
      return error;
    }
  }

  @TableController(teams, excluded)
  @Inherit()
  class ExcludedTeams extends AsDbController {
    protected override validateControls(controls: Record<string, unknown>, type: any) {
      const error = super.validateControls(controls, type);
      if (!error) selectTeam(controls, { name: 0 });
      return error;
    }
  }

  send = await bootHttp(ScopedTeams, PlainTeams, Projects, IncludedTeams, ExcludedTeams);
});

describe("an in-read adapter behind a controller", () => {
  it("receives the server-conjoined filter and the restricted $select in the entry", async () => {
    InReadMemoryAdapter.entries = [];
    const res = await send("GET", `/${scoped}/query?$with=members(name=Ann&$select=name,role)`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, name: "Core", members: [] }]);
    const [entry] = InReadMemoryAdapter.entries[0]!;
    expect(entry).toMatchObject({ kind: "from", nav: "members", isArray: true });
    expect(entry!.query.filter).toEqual({ $and: [{ role: "staff" }, { name: "Ann" }] });
    expect(entry!.query.controls.$select?.asArray).toEqual(["id", "name"]);
  });

  it.each([
    ["inclusion", () => included, ["id", "name"]],
    ["exclusion expanded to the leaves", () => excluded, ["id"]],
  ])(
    "a depth-2 entry's object $select (%s) reaches the nested in-read entry",
    async (_name, prefix, fields) => {
      InReadMemoryAdapter.entries = [];
      const res = await send("GET", `/${prefix()}/query?$with=members($with=team)`);
      expect(res.status).toBe(200);
      const [members] = InReadMemoryAdapter.entries[0]!;
      const [team] = members!.query.controls.$with!;
      expect(team).toMatchObject({ kind: "to", nav: "team", isArray: false });
      expect(team!.query.controls.$select?.asArray).toEqual(fields);
    },
  );

  it("refuses paging inside $with with 400 NOT_SUPPORTED", async () => {
    const res = await send("GET", `/${scoped}/query?$with=members($limit=1)`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOT_SUPPORTED");
  });
});

describe("/meta relations[].filterable", () => {
  it("is offered when the adapter renders relational predicates", async () => {
    const { relations } = (await send("GET", `/${scoped}/meta`)).body;
    expect(relations).toEqual([
      { name: "members", direction: "from", isArray: true, filterable: true },
    ]);
  });

  it("is left out when it does not (supportsRelationFilters('read') false)", async () => {
    const { relations } = (await send("GET", `/${plain}/meta`)).body;
    expect(relations).toEqual([{ name: "members", direction: "from", isArray: true }]);
  });
});

describe("@db.rel.store over HTTP", () => {
  it("/meta lists it with direction 'store'", async () => {
    const { relations } = (await send("GET", `/${projects}/meta`)).body;
    expect(relations).toEqual([{ name: "lead", direction: "store", isArray: false }]);
  });

  it("a write with a value in it answers 400 NAV_STORE_WRITE", async () => {
    const res = await send("POST", `/${projects}`, { id: 1, name: "P", lead: null });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([
      expect.objectContaining({ path: "lead", code: "NAV_STORE_WRITE" }),
    ]);
  });
});
