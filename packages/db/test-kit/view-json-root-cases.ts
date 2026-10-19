import { it, expect } from "vite-plus/test";

/**
 * The shared cases of a view over a whole primitive `@db.json` field
 * (`fixtures/view-json-root.as` of each adapter): the view returns the typed
 * JSON root value — `9`, not the JSON text — and sorts / filters by it (since
 * 0.1.162). The adapter syncs `VjrItem` + `VjrItemView` and inserts
 * {@link VJR_ITEMS} before the cases run.
 */
export const VJR_ITEMS = [
  { id: 1, score: 9, label: "b", active: true },
  { id: 2, score: 10, label: "a", active: false },
  { id: 3, score: 2.5, label: "c", active: true },
  { id: 4 },
] as never;

export interface TViewJsonRootKit {
  /** The synced, seeded `VjrItemView` (read when a case runs). */
  view: () => any;
  /** Drop each row's `_id` before comparing (a MongoDB document carries one). */
  omitId?: boolean;
}

export function defineViewJsonRootCases(kit: TViewJsonRootKit): void {
  const ids = async (query: { filter?: object; controls?: object }) =>
    (
      (await kit.view().findMany({
        filter: query.filter ?? {},
        controls: { $select: ["id"], ...query.controls },
      })) as Array<{ id: number }>
    ).map((r) => r.id);

  it("returns the typed values", async () => {
    const rows = (await kit
      .view()
      .findMany({ filter: {}, controls: { $sort: { id: 1 } } })) as Array<Record<string, unknown>>;
    expect(kit.omitId ? rows.map(({ _id, ...rest }) => rest) : rows).toEqual([
      { id: 1, score: 9, label: "b", active: true },
      { id: 2, score: 10, label: "a", active: false },
      { id: 3, score: 2.5, label: "c", active: true },
      { id: 4, score: null, label: null, active: null },
    ]);
  });

  it("sorts and filters by the typed value", async () => {
    expect(
      await ids({ filter: { score: { $exists: true } }, controls: { $sort: { score: 1 } } }),
    ).toEqual([3, 1, 2]);
    expect(
      await ids({ filter: { score: { $gt: 5 } }, controls: { $sort: { score: -1 } } }),
    ).toEqual([2, 1]);
    expect(await ids({ filter: { active: true }, controls: { $sort: { id: 1 } } })).toEqual([1, 3]);
    expect(
      await ids({ filter: { label: { $exists: true } }, controls: { $sort: { label: 1 } } }),
    ).toEqual([2, 1, 3]);
  });
}
