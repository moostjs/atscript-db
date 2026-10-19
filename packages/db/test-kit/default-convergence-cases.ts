import { it, expect } from "vite-plus/test";
import { SchemaSync, type SyncEntry } from "@atscript/db/sync";

/**
 * The shared behaviour table of schema-sync convergence over column defaults
 * (since 0.1.162): a schema with every default kind (`fixtures/default-kinds.as`
 * of each adapter) synced once with `force: true` must re-plan and re-run
 * all `in-sync` — the defaults compare canonically, whatever literal the DDL
 * wrote and however the engine reports it. Every `alter` entry, planned or
 * run, prints what it changes (never `— in sync`).
 *
 * Run by SQLite and the memory adapter always, and by the MySQL / PostgreSQL
 * live suites against a server.
 */
export interface TDefaultConvergenceKit {
  fx: Record<string, any>;
  space: ConstructorParameters<typeof SchemaSync>[0];
  /** Gives the live `dk_teams.name` the default `'zz'` (the model has none; omitted: no drift case). */
  driftTeamNameDefault?: () => Promise<void>;
  /** Drops the live FK `dk_members.teamId → dk_teams` by hand (omitted: no live-FK case). */
  dropMemberFk?: () => Promise<void>;
  /** The adapter reports index work (`planIndexes` + `syncIndexes` changes); omitted: no index case. */
  indexes?: boolean;
}

/** The models of `fixtures/default-kinds.as`, parents first. */
export function defaultKindModels(fx: Record<string, any>): any[] {
  return [fx.DkDefaults, fx.DkTeam, fx.DkMember, fx.DkIndexed];
}

/** Lines an entry prints under its header that say what changes (dependency notes excluded). */
export function detailLines(entry: SyncEntry, mode: "plan" | "result"): string[] {
  return entry
    .print(mode)
    .slice(1)
    .filter((l) => l.trim() !== "" && !l.includes("· after:") && !l.includes("· dropped with:"));
}

/**
 * The invariant: an `alter` entry prints at least one detail line, or a
 * `recreated` / `renamed from` header — and never `— in sync`.
 */
export function expectAlterEntriesExplained(
  entries: readonly SyncEntry[],
  mode: "plan" | "result",
): void {
  for (const entry of entries.filter((e) => e.status === "alter")) {
    const lines = entry.print(mode);
    const header = lines[0] ?? "";
    expect(header, `${entry.name} (${mode})`).not.toContain("in sync");
    const explained =
      detailLines(entry, mode).length > 0 ||
      header.includes("recreated") ||
      header.includes("renamed from");
    expect(explained, `${entry.name} (${mode}): ${lines.join(" | ")}`).toBe(true);
  }
}

/** Non-`in-sync` entries as `name:status` plus their printed lines — a readable failure. */
function changed(entries: readonly SyncEntry[], mode: "plan" | "result"): string[] {
  return entries
    .filter((e) => e.status !== "in-sync")
    .map((e) => `${e.name}:${e.status} ${e.print(mode).join(" | ")}`);
}

/** `action:<index>` for the three changed indexes, whatever the adapter names them. */
const indexSummary = (entry: SyncEntry): string[] =>
  entry.indexChanges
    .map((ic) => {
      const which = ["by_rank", "by_title", "by_team_rank"].find((n) =>
        new RegExp(`(^|_)${n}$`).test(ic.name),
      );
      return `${ic.action}:${which ?? ic.name}`;
    })
    .toSorted();

export function defineDefaultConvergenceCases(kit: () => TDefaultConvergenceKit): void {
  const sync = () => new SchemaSync(kit().space);
  const models = () => defaultKindModels(kit().fx);

  it("a second forced sync of every default kind is all in sync (no alter)", async () => {
    const first = await sync().run(models(), { force: true });
    expect(first.status).toBe("synced");
    expectAlterEntriesExplained(first.entries, "result");

    for (let i = 0; i < 2; i++) {
      const plan = await sync().plan(models(), { force: true });
      expect(changed(plan.entries, "plan")).toEqual([]);
      const run = await sync().run(models(), { force: true });
      expect(changed(run.entries, "result")).toEqual([]);
      for (const entry of run.entries) {
        expect(entry.print("result")[0]).toContain("in sync");
      }
    }
  });

  it("an FK added on its own is `alter` in the plan and in the run, and printed", async () => {
    const { fx } = kit();
    await sync().run([fx.DkDefaults, fx.DkTeam, fx.DkMemberNoFk, fx.DkIndexed], { force: true });

    const plan = await sync().plan(models(), { force: true });
    const planned = plan.entries.find((e) => e.name === "dk_members")!;
    expect(planned.status).toBe("alter");
    expect(planned.fkAdded).toEqual([{ fields: ["teamId"], targetTable: "dk_teams" }]);
    expectAlterEntriesExplained(plan.entries, "plan");

    const run = await sync().run(models(), { force: true });
    const entry = run.entries.find((e) => e.name === "dk_members")!;
    expect(entry.status).toBe("alter");
    expect(entry.fkAdded).toEqual([{ fields: ["teamId"], targetTable: "dk_teams" }]);
    expect(entry.print("result").join("\n")).toMatch(
      entry.recreated ? /recreated/ : /\+ FK\(teamId\) → dk_teams — added/,
    );
    expectAlterEntriesExplained(run.entries, "result");

    const again = await sync().plan(models(), { force: true });
    expect(changed(again.entries, "plan")).toEqual([]);
  });

  it("a real default drift is applied once, and the run entry prints it", async () => {
    const k = kit();
    if (!k.driftTeamNameDefault) return;
    await sync().run(models(), { force: true });
    await k.driftTeamNameDefault();

    const plan = await sync().plan(models(), { force: true });
    const planned = plan.entries.find((e) => e.name === "dk_teams")!;
    expect(planned.status).toBe("alter");
    expect(planned.defaultChanges).toEqual([
      { column: "name", oldDefault: "zz", newDefault: undefined },
    ]);

    const run = await sync().run(models(), { force: true });
    const entry = run.entries.find((e) => e.name === "dk_teams")!;
    expect(entry.status).toBe("alter");
    expect(entry.defaultChanges).toEqual(planned.defaultChanges);
    expect(entry.print("result").join("\n")).toContain("~ name — default zz → none");
    expectAlterEntriesExplained(run.entries, "result");

    const again = await sync().plan(models(), { force: true });
    expect(changed(again.entries, "plan")).toEqual([]);
  });

  it("index work is `alter` in the plan and in the run, printed, then converges", async () => {
    const { fx, indexes } = kit();
    if (!indexes) return;
    const v2 = [fx.DkDefaults, fx.DkTeam, fx.DkMember, fx.DkIndexedV2];
    await sync().run(models(), { force: true });

    const expected = ["add:by_rank", "drop:by_title", "rebuild:by_team_rank"];

    const plan = await sync().plan(v2, { force: true });
    const planned = plan.entries.find((e) => e.name === "dk_indexed")!;
    expect(planned.status).toBe("alter");
    expect(indexSummary(planned)).toEqual(expected);
    expectAlterEntriesExplained(plan.entries, "plan");
    expect(changed(plan.entries, "plan").filter((l) => !l.startsWith("dk_indexed:"))).toEqual([]);

    const run = await sync().run(v2, { force: true });
    const entry = run.entries.find((e) => e.name === "dk_indexed")!;
    expect(entry.status).toBe("alter");
    expect(indexSummary(entry)).toEqual(expected);
    const printed = entry.print("result").join("\n");
    expect(printed).toMatch(/\+ index \S*by_rank — added/);
    expect(printed).toMatch(/- index \S*by_title — dropped/);
    expect(printed).toMatch(/~ index \S*by_team_rank — rebuilt/);
    expectAlterEntriesExplained(run.entries, "result");

    const again = await sync().plan(v2, { force: true });
    expect(changed(again.entries, "plan")).toEqual([]);
    const rerun = await sync().run(v2, { force: true });
    expect(changed(rerun.entries, "result")).toEqual([]);
  });

  it("a foreign key dropped by hand is planned, re-added by a forced run and reported", async () => {
    const k = kit();
    if (!k.dropMemberFk) return;
    await sync().run(models(), { force: true });
    await k.dropMemberFk();

    const plan = await sync().plan(models(), { force: true });
    const planned = plan.entries.find((e) => e.name === "dk_members")!;
    expect(planned.status).toBe("alter");
    expect(planned.fkAdded).toEqual([{ fields: ["teamId"], targetTable: "dk_teams" }]);

    const run = await sync().run(models(), { force: true });
    const entry = run.entries.find((e) => e.name === "dk_members")!;
    expect(entry.status).toBe("alter");
    expect(entry.print("result").join("\n")).toContain("+ FK(teamId) → dk_teams — added");
    expectAlterEntriesExplained(run.entries, "result");

    const again = await sync().plan(models(), { force: true });
    expect(changed(again.entries, "plan")).toEqual([]);
  });
}
