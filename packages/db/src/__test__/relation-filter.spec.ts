import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "@atscript/core";
import { tsPlugin } from "@atscript/typescript";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { DbError } from "../db-error";
import dbPlugin from "../plugin";
import {
  REL_FILTER_CLIENT_MAX_DEPTH,
  REL_FILTER_CLIENT_MAX_NODES,
  REL_FILTER_MAX_DEPTH,
  REL_FILTER_MAX_NODES,
  ResolvedRelationFilter,
  containsRelationPredicate,
  forEachResolvedRelation,
  isResolvedRelationFilter,
  relationStaticFilter,
} from "../query/relation-filter";
import { computeTableSnapshot } from "../schema/schema-hash";
import { AtscriptDbTable } from "../table/db-table";
import { DbSpace } from "../table/db-space";
import type { DbQuery } from "../types";

import { MockAdapter, prepareFixtures } from "./test-utils";

// Relational filter predicates ($some / $none), since 0.1.147: the core
// guards and resolves every predicate against the related tables before the
// adapter sees the filter (ResolvedRelationFilter, physical names).

/** A mock adapter that renders relational predicates (read + write). */
class RelMockAdapter extends MockAdapter {
  override supportsRelationFilters(): boolean {
    return true;
  }
}

/** Renders predicates on reads only. */
class ReadOnlyRelMockAdapter extends MockAdapter {
  override supportsRelationFilters(mode: "read" | "write"): boolean {
    return mode === "read";
  }
}

/** Same class, bound to a distinct connection (its own transaction owner). */
class ConnRelMockAdapter extends MockAdapter {
  constructor(readonly conn: object) {
    super();
  }
  override supportsRelationFilters(): boolean {
    return true;
  }
  protected override _transactionOwner(): unknown {
    return this.conn;
  }
}

/** A different adapter class (same capability). */
class OtherRelMockAdapter extends MockAdapter {
  override supportsRelationFilters(): boolean {
    return true;
  }
}

let fx: Record<string, any>;
const encryption = { defaultKeyId: "k1", keys: { k1: randomBytes(32) } };

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/rel-filter.as");
});

function space(factory: () => MockAdapter = () => new RelMockAdapter()) {
  return new DbSpace(factory, { encryption });
}

/** The filter the adapter received on its last call of `method`. */
function lastFilter(table: AtscriptDbTable<any>, method = "findMany"): Record<string, any> {
  const adapter = table.getAdapter() as unknown as MockAdapter;
  const call = adapter.calls.findLast((c) => c.method === method);
  expect(call, `adapter.${method} was called`).toBeDefined();
  const arg = call!.args[0] as DbQuery | Record<string, unknown>;
  return ((arg as DbQuery).filter ?? arg) as Record<string, any>;
}

/** `n` top-level predicates ANDed. */
function manyPredicates(n: number) {
  return {
    $and: Array.from({ length: n }, (_, i) => ({ ticket: { $some: { status: `s${i}` } } })),
  };
}

async function rejection(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DbError);
    return error as DbError;
  }
  throw new Error("expected a DbError");
}

describe("resolution (ResolvedRelationFilter)", () => {
  it("to: correlates the source FK column with the target key (physical names)", async () => {
    const db = space();
    const issues = db.getTable(fx.RfIssue);
    await issues.findMany({ filter: { ticket: { $some: { teamId: "t1", status: "open" } } } });
    const node = lastFilter(issues).ticket.$some as ResolvedRelationFilter;
    expect(node).toBeInstanceOf(ResolvedRelationFilter);
    expect(node.kind).toBe("to");
    expect(node.nav).toBe("ticket");
    expect(node.source.name).toBe("rf_issues");
    expect(node.target.name).toBe("rf_tickets");
    expect(node.pairs).toEqual([{ source: "ticket_ref", target: "key" }]);
    // the inner filter is translated by the TARGET mapper (`@db.column` rename)
    expect(node.filter).toEqual({ team_ref: "t1", status: "open" });
    expect(node.target.adapter).toBe(db.getTable(fx.RfTicket).getAdapter());
  });

  it("from: correlates the source key with the remote FK column", async () => {
    const tickets = space().getTable(fx.RfTicket);
    await tickets.findMany({ filter: { issues: { $none: {} } } });
    const node = lastFilter(tickets).issues.$none as ResolvedRelationFilter;
    expect(node.kind).toBe("from");
    expect(node.pairs).toEqual([{ source: "key", target: "ticket_ref" }]);
    expect(node.filter).toEqual({});
  });

  it("via: correlates through the junction on both sides", async () => {
    const tickets = space().getTable(fx.RfTicket);
    await tickets.findMany({ filter: { labels: { $some: { name: "bug" } } } });
    const node = lastFilter(tickets).labels.$some as ResolvedRelationFilter;
    expect(node.kind).toBe("via");
    expect(node.pairs).toEqual([]);
    expect(node.junction?.name).toBe("rf_ticket_labels");
    expect(node.junction?.toSource).toEqual([{ junction: "ticketKey", source: "key" }]);
    expect(node.junction?.toTarget).toEqual([{ junction: "labelId", target: "id" }]);
    expect(node.junction?.filter).toBeUndefined();
    expect(node.filter).toEqual({ label_name: "bug" });
  });

  it("composite foreign keys yield one pair per key part", async () => {
    const cards = space().getTable(fx.RfCard);
    await cards.findMany({ filter: { board: { $some: { title: "x" } } } });
    const node = lastFilter(cards).board.$some as ResolvedRelationFilter;
    expect(node.pairs).toEqual([
      { source: "boardOrg", target: "org" },
      { source: "boardCode", target: "code" },
    ]);
  });

  it("self relation: target is the same table", async () => {
    const tickets = space().getTable(fx.RfTicket);
    await tickets.findMany({ filter: { parent: { $some: { status: "open" } } } });
    const node = lastFilter(tickets).parent.$some as ResolvedRelationFilter;
    expect(node.target.name).toBe("rf_tickets");
    expect(node.pairs).toEqual([{ source: "parentKey", target: "key" }]);
  });

  it("nested predicates are resolved by the related table, under $or / $not too", async () => {
    const issues = space().getTable(fx.RfIssue);
    await issues.findMany({
      filter: {
        $or: [{ title: "a" }, { $not: { ticket: { $some: { team: { $none: { name: "x" } } } } } }],
      },
    });
    const filter = lastFilter(issues);
    const outer = filter.$or[1].$not.ticket.$some as ResolvedRelationFilter;
    const inner = (outer.filter as Record<string, any>).team.$none as ResolvedRelationFilter;
    expect(inner).toBeInstanceOf(ResolvedRelationFilter);
    expect(inner.source.name).toBe("rf_tickets");
    expect(inner.pairs).toEqual([{ source: "team_ref", target: "id" }]);
    expect(inner.filter).toEqual({ name: "x" });
    const seen: string[] = [];
    forEachResolvedRelation(filter, (node, op) => seen.push(`${node.nav}:${op}`));
    expect(seen).toEqual(["ticket:$some", "team:$none"]);
  });

  it("$some and $none on one key are both resolved", async () => {
    const issues = space().getTable(fx.RfIssue);
    await issues.count({
      filter: { ticket: { $some: { status: "open" }, $none: { teamId: "t9" } } },
    });
    const f = lastFilter(issues, "count");
    expect(f.ticket.$some).toBeInstanceOf(ResolvedRelationFilter);
    expect(f.ticket.$none.filter).toEqual({ team_ref: "t9" });
  });

  it("aggregate filters resolve predicates", async () => {
    const issues = space().getTable(fx.RfIssue);
    await issues.aggregate({
      filter: { ticket: { $some: { status: "open" } } },
      controls: { $groupBy: ["title"], $select: ["title"] },
    });
    const adapter = issues.getAdapter() as unknown as MockAdapter;
    const call = adapter.calls.findLast((c) => c.method === "aggregate")!;
    expect((call.args[0] as DbQuery).filter as Record<string, any>).toHaveProperty("ticket.$some");
    expect(((call.args[0] as DbQuery).filter as Record<string, any>).ticket.$some).toBeInstanceOf(
      ResolvedRelationFilter,
    );
  });

  it("translating twice keeps the resolved node (idempotent)", async () => {
    const db = space();
    const issues = db.getTable(fx.RfIssue);
    await issues.deleteMany({ ticket: { $some: { status: "closed" } } });
    const f = lastFilter(issues, "deleteMany");
    expect(f.ticket.$some).toBeInstanceOf(ResolvedRelationFilter);
    expect(containsRelationPredicate(f)).toBe(true);
    expect(containsRelationPredicate({ a: 1, $or: [{ b: { $ne: 2 } }] })).toBe(false);
  });

  it("predicate-free filters reach the adapter unchanged", async () => {
    const issues = space().getTable(fx.RfIssue);
    await issues.findMany({ filter: { title: "a" } });
    expect(lastFilter(issues)).toEqual({ title: "a" });
  });
});

describe("@db.rel.filter is part of the relation", () => {
  it("from: the target condition is ANDed into the predicate operand", async () => {
    const teams = space().getTable(fx.RfTeam);
    await teams.findMany({ filter: { openTickets: { $some: {} } } });
    const node = lastFilter(teams).openTickets.$some as ResolvedRelationFilter;
    expect(node.filter).toEqual({ status: { $eq: "open" } });
    expect(node.pairs).toEqual([{ source: "id", target: "team_ref" }]);
  });

  it("via: junction conditions go to the junction, target ones to the target", async () => {
    const tickets = space().getTable(fx.RfTicket);
    await tickets.findMany({ filter: { pinnedLabels: { $none: { id: 3 } } } });
    const node = lastFilter(tickets).pinnedLabels.$none as ResolvedRelationFilter;
    expect(node.junction?.filter).toEqual({ pinned: { $eq: true } });
    expect(node.filter).toEqual({ $and: [{ label_name: { $ne: "hidden" } }, { id: 3 }] });
  });

  it("relationStaticFilter splits by side (logical names)", () => {
    const tickets = space().getTable(fx.RfTicket);
    const rel = tickets.relations.get("pinnedLabels")!;
    expect(relationStaticFilter(rel, "pinnedLabels")).toEqual({
      junction: { pinned: { $eq: true } },
      target: { name: { $ne: "hidden" } },
    });
    expect(relationStaticFilter(tickets.relations.get("labels")!)).toEqual({});
  });

  it("$with loading applies the condition (from) — regression: it used to be ignored", async () => {
    const db = space();
    const teams = db.getTable(fx.RfTeam);
    const tickets = db.getTable(fx.RfTicket);
    const ticketStore = tickets.getAdapter() as unknown as MockAdapter;
    ticketStore.store.set("rf_tickets", [
      { key: "T1", status: "open", team_ref: "A" },
      { key: "T2", status: "closed", team_ref: "A" },
    ]);
    (teams.getAdapter() as unknown as MockAdapter).store.set("rf_teams", [{ id: "A", name: "a" }]);
    const rows = (await teams.findMany({
      filter: {},
      controls: { $with: [{ name: "openTickets" }] },
    })) as Array<Record<string, any>>;
    // Unfiltered, both tickets of team A would load.
    expect(rows[0]?.openTickets.map((t: any) => t.key)).toEqual(["T1"]);
  });

  it("$with loading applies the condition (via): junction + target parts", async () => {
    const db = space();
    const tickets = db.getTable(fx.RfTicket);
    const junction = db.getTable(fx.RfTicketLabel);
    const labels = db.getTable(fx.RfLabel);
    (tickets.getAdapter() as unknown as MockAdapter).store.set("rf_tickets", [
      { key: "T1", status: "open" },
    ]);
    await tickets.findMany({ filter: {}, controls: { $with: [{ name: "pinnedLabels" }] } });
    expect(lastFilter(junction)).toEqual({
      $and: [{ ticketKey: { $in: ["T1"] } }, { pinned: { $eq: true } }],
    });
    void labels;
  });
});

describe("guards", () => {
  it("dotted navigation paths name the predicate form", async () => {
    const issues = space().getTable(fx.RfIssue);
    const err = await rejection(issues.findMany({ filter: { "ticket.status": "open" } as any }));
    expect(err.code).toBe("INVALID_QUERY");
    expect(err.message).toContain('Cannot filter on "ticket.status" — navigation path');
    expect(err.message).toContain("use { ticket: { $some: { status: … } } }");
  });

  it("a bare comparison on a navigation field names the predicate form", async () => {
    const issues = space().getTable(fx.RfIssue);
    const err = await rejection(issues.findMany({ filter: { ticket: "T1" } as any }));
    expect(err.message).toContain("use { ticket: { $some: … } }");
  });

  it("rejects $some / $none on a non-navigation field", async () => {
    const issues = space().getTable(fx.RfIssue);
    const err = await rejection(issues.findMany({ filter: { title: { $some: {} } } as any }));
    expect(err.code).toBe("INVALID_QUERY");
    expect(err.message).toContain("only valid on a navigation relation");
  });

  it("rejects mixing relation and comparison operators on one key", async () => {
    const issues = space().getTable(fx.RfIssue);
    const err = await rejection(
      issues.findMany({ filter: { ticket: { $some: {}, $eq: 1 } } as any }),
    );
    expect(err.message).toContain('Cannot mix "$some" / "$none" with "$eq"');
  });

  it("requires a filter object as operand", async () => {
    const issues = space().getTable(fx.RfIssue);
    const err = await rejection(issues.findMany({ filter: { ticket: { $some: 5 } } as any }));
    expect(err.message).toContain('"$some" on "ticket" expects a filter object');
  });

  it("guards the operand with the related table's rules (unknown / encrypted)", async () => {
    const issues = space().getTable(fx.RfIssue);
    const unknown = await rejection(
      issues.findMany({ filter: { ticket: { $some: { nope: 1 } } } as any }),
    );
    expect(unknown.code).toBe("INVALID_QUERY");
    expect(unknown.errors[0]?.path).toBe("ticket.nope");
    const encrypted = await rejection(
      issues.findMany({ filter: { ticket: { $some: { note: "x" } } } as any }),
    );
    expect(encrypted.code).toBe("ENC_FIELD_FILTER");
    expect(encrypted.errors[0]?.path).toBe("ticket.note");
  });

  it(`caps nesting depth at ${REL_FILTER_MAX_DEPTH} (headroom above the client cap of 3)`, async () => {
    expect(REL_FILTER_MAX_DEPTH).toBeGreaterThan(REL_FILTER_CLIENT_MAX_DEPTH);
    const issues = space().getTable(fx.RfIssue);
    const four = {
      ticket: { $some: { parent: { $some: { parent: { $some: { team: { $some: {} } } } } } } },
    };
    await expect(issues.findMany({ filter: four as any })).resolves.toBeDefined();
    const five = {
      ticket: {
        $some: {
          parent: { $some: { parent: { $some: { parent: { $some: { team: { $some: {} } } } } } } },
        },
      },
    };
    const err = await rejection(issues.findMany({ filter: five as any }));
    expect(err.code).toBe("INVALID_QUERY");
    // the caps count server-added predicates too: no path, no chain in the message
    expect(err.errors).toEqual([
      { path: "", message: "Relational predicates nest at most 4 levels deep" },
    ]);
  });

  it(`caps the predicate count at ${REL_FILTER_MAX_NODES} (headroom above the client cap of 8)`, async () => {
    expect(REL_FILTER_MAX_NODES).toBeGreaterThan(REL_FILTER_CLIENT_MAX_NODES);
    const issues = space().getTable(fx.RfIssue);
    await expect(issues.findMany({ filter: manyPredicates(16) as any })).resolves.toBeDefined();
    const err = await rejection(issues.findMany({ filter: manyPredicates(17) as any }));
    expect(err.errors).toEqual([
      { path: "", message: "At most 16 relational predicates per query" },
    ]);
  });

  it("rejects predicates in $having", async () => {
    const issues = space().getTable(fx.RfIssue);
    const err = await rejection(
      issues.aggregate({
        controls: {
          $groupBy: ["title"],
          $select: ["title"],
          $having: { ticket: { $some: {} } } as any,
        },
      }),
    );
    expect(err.code).toBe("INVALID_QUERY");
  });

  it("adapter without predicate support → REL_FILTER_NOT_SUPPORTED", async () => {
    const issues = space(() => new MockAdapter()).getTable(fx.RfIssue);
    const err = await rejection(issues.findMany({ filter: { ticket: { $some: {} } } }));
    expect(err.code).toBe("REL_FILTER_NOT_SUPPORTED");
  });

  it("write mode: mutation filters need supportsRelationFilters('write')", async () => {
    const issues = space(() => new ReadOnlyRelMockAdapter()).getTable(fx.RfIssue);
    await expect(issues.count({ filter: { ticket: { $some: {} } } })).resolves.toBe(0);
    const err = await rejection(issues.deleteMany({ ticket: { $some: {} } } as any));
    expect(err.code).toBe("REL_FILTER_NOT_SUPPORTED");
    expect(err.message).toContain("mutation filters");
    const upd = await rejection(
      issues.updateMany({ ticket: { $none: {} } } as any, { title: "x" }),
    );
    expect(upd.code).toBe("REL_FILTER_NOT_SUPPORTED");
  });

  it("related table on a different adapter class → REL_FILTER_NOT_SUPPORTED", async () => {
    let n = 0;
    const db = space(() => (n++ === 0 ? new RelMockAdapter() : new OtherRelMockAdapter()));
    const issues = db.getTable(fx.RfIssue);
    db.getTable(fx.RfTicket);
    const err = await rejection(issues.findMany({ filter: { ticket: { $some: {} } } }));
    expect(err.code).toBe("REL_FILTER_NOT_SUPPORTED");
    expect(err.message).toContain("different database or adapter");
    // the client-visible message names the nav path, never a physical table
    expect(err.message).not.toMatch(/rf_tickets/);
  });

  it("same adapter class on a DIFFERENT connection → REL_FILTER_NOT_SUPPORTED", async () => {
    let n = 0;
    const connA = {};
    const db = space(() => new ConnRelMockAdapter(n++ === 0 ? connA : {}));
    const issues = db.getTable(fx.RfIssue);
    db.getTable(fx.RfTicket);
    const err = await rejection(issues.findMany({ filter: { ticket: { $some: {} } } }));
    expect(err.code).toBe("REL_FILTER_NOT_SUPPORTED");
    expect(err.message).not.toMatch(/rf_tickets/);
  });

  it("same adapter class on the SAME connection → allowed", async () => {
    const conn = {};
    const db = space(() => new ConnRelMockAdapter(conn));
    const issues = db.getTable(fx.RfIssue);
    db.getTable(fx.RfTicket);
    await expect(issues.findMany({ filter: { ticket: { $some: {} } } })).resolves.toEqual([]);
  });

  it("isResolvedRelationFilter is a cross-realm brand check, not instanceof", () => {
    const foreign = { [Symbol.for("@atscript/db:ResolvedRelationFilter")]: true, kind: "to" };
    expect(isResolvedRelationFilter(foreign)).toBe(true);
    expect(isResolvedRelationFilter({ kind: "to" })).toBe(false);
    expect(isResolvedRelationFilter(null)).toBe(false);
  });

  it("table built without a DbSpace → REL_FILTER_NOT_SUPPORTED", async () => {
    const issues = new AtscriptDbTable(fx.RfIssue, new RelMockAdapter());
    const err = await rejection(issues.findMany({ filter: { ticket: { $some: {} } } }));
    expect(err.code).toBe("REL_FILTER_NOT_SUPPORTED");
    expect(err.message).toContain("DbSpace");
  });

  it("self-referencing junction → INVALID_QUERY", async () => {
    const tickets = space().getTable(fx.RfTicket);
    const err = await rejection(tickets.findMany({ filter: { related: { $some: {} } } }));
    expect(err.code).toBe("INVALID_QUERY");
    expect(err.message).toContain("self-referencing many-to-many");
  });
});

describe("@db.rel.filterable", () => {
  it("is recorded on the relation (and only there)", () => {
    const issues = space().getTable(fx.RfIssue);
    expect(issues.relations.get("ticket")?.filterable).toBe(true);
    expect(space().getTable(fx.RfTeam).relations.get("openTickets")?.filterable).toBeUndefined();
  });

  it("never enters the schema hash snapshot", () => {
    const issues = space().getTable(fx.RfIssue);
    const snapshot = JSON.stringify(computeTableSnapshot(issues as any));
    expect(snapshot).not.toMatch(/filterable|rel\.filter/);
  });

  it("is only valid on navigation fields", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "rel-filterable-"));
    writeFileSync(
      join(rootDir, "fixture.as"),
      `@db.table 'a'
export interface A {
    @meta.id
    id: number

    @db.rel.filterable
    title: string

    @db.rel.FK
    bId?: B.id

    @db.rel.to
    @db.rel.filterable
    b?: B
}

@db.table 'b'
export interface B {
    @meta.id
    id: number
}
`,
    );
    const repo = await build({
      rootDir,
      entries: ["fixture.as"],
      plugins: [tsPlugin(), dbPlugin()],
    });
    const messages = [...(await repo.diagnostics()).values()].flat().map((m) => m.message);
    expect(messages.filter((m) => m.includes("@db.rel.filterable"))).toEqual([
      "@db.rel.filterable is only valid on navigational fields (@db.rel.to, @db.rel.from, or @db.rel.via)",
    ]);
  });
});

describe("@db.rel.filter compile-time diagnostics mirror the runtime limits", () => {
  const SOURCE = `@db.table 'df_tickets'
export interface DfTicket {
    @meta.id
    key: string
    status: string
    closedStatus: string

    // FL5: field-to-field comparison (any relation kind)
    @db.rel.from
    @db.rel.filter \`DfIssue.title = DfIssue.body\`
    cmpIssues?: DfIssue[]

    // OK: field-to-value conditions
    @db.rel.from
    @db.rel.filter \`DfIssue.title != '' and DfIssue.body exists\`
    okIssues?: DfIssue[]

    // FL4: one top-level condition reads the junction AND the related type
    @db.rel.via DfTicketLabel
    @db.rel.filter \`DfTicketLabel.pinned = true or DfLabel.name = 'bug'\`
    mixedLabels?: DfLabel[]

    // FL4 through a parenthesized and-group (the runtime splits top-level conditions only)
    @db.rel.via DfTicketLabel
    @db.rel.filter \`DfLabel.name != 'x' and (DfTicketLabel.pinned = true and name != 'y')\`
    groupedLabels?: DfLabel[]

    // OK: each top-level condition reads one side
    @db.rel.via DfTicketLabel
    @db.rel.filter \`DfTicketLabel.pinned = true and DfLabel.name != 'hidden' and name != 'x'\`
    okLabels?: DfLabel[]
}

@db.table 'df_issues'
export interface DfIssue {
    @meta.id
    id: number
    title: string
    body?: string

    @db.rel.FK
    ticketKey?: DfTicket.key
}

@db.table 'df_labels'
export interface DfLabel {
    @meta.id
    id: number
    name: string
}

@db.table 'df_ticket_labels'
export interface DfTicketLabel {
    @meta.id
    id: number

    @db.rel.FK
    ticketKey: DfTicket.key

    @db.rel.FK
    labelId: DfLabel.id

    pinned?: boolean
}
`;

  it("reports field-to-field comparisons and junction/target-mixing conditions, nothing else", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "rel-filter-diag-"));
    writeFileSync(join(rootDir, "fixture.as"), SOURCE);
    const repo = await build({
      rootDir,
      entries: ["fixture.as"],
      plugins: [tsPlugin(), dbPlugin()],
    });
    const messages = [...(await repo.diagnostics()).values()]
      .flat()
      .filter((m) => m.message.includes("@db.rel.filter"));
    const lines = SOURCE.split("\n");
    const at = (m: (typeof messages)[number]) => {
      // the nav field the annotation belongs to (first prop line after the diagnostic)
      const line = m.range.start.line;
      return lines
        .slice(line)
        .find((l) => /^\s+\w+\??: /.test(l))!
        .trim()
        .split(/\??:/)[0];
    };
    expect(messages.map((m) => [at(m), m.message])).toEqual([
      [
        "cmpIssues",
        "@db.rel.filter compares two fields — only field-to-value conditions are supported",
      ],
      [
        "mixedLabels",
        `@db.rel.filter has a condition reading both the junction 'DfTicketLabel' and the related type — split it into separate top-level "and" conditions`,
      ],
      [
        "groupedLabels",
        `@db.rel.filter has a condition reading both the junction 'DfTicketLabel' and the related type — split it into separate top-level "and" conditions`,
      ],
    ]);
  });
});
