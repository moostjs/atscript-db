/**
 * Calendar buckets on the client (since 0.1.132): `aggregate()` types a bucket
 * as its `YYYY-MM-DD` label, accepts a bucket alias in `$groupBy` (and rejects
 * a typo), and serializes the object form to the `bucket(...)` URL grammar.
 */
import { describe, it, expect, expectTypeOf, vi } from "vite-plus/test";

import { Client, bucketStartInstant, nextBucketLabel, type NextBucketOptions } from "../index";

declare class Ticket {
  id: number;
  status: string;
  openedAt: number;
  closedAt?: number;
  points: number;
  static __is_atscript_annotated_type: true;
  static type: { __dataType?: Ticket };
  static __ownProps: {
    id: number;
    status: string;
    openedAt: number;
    closedAt?: number;
    points: number;
  };
  static __navProps: {};
  static __pk: number;
}

function mockFetch(body: unknown) {
  return vi.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(body),
    }),
  );
}

describe("aggregate() with calendar buckets", () => {
  it("types bucket labels (nullable for an optional source) next to dimensions and measures", () => {
    if (!shouldRun()) {
      const c = new Client<typeof Ticket>("/api/tickets");
      const rows = c.aggregate({
        controls: {
          $select: [
            "status",
            {
              $bucket: "week",
              $field: "openedAt",
              $tz: "Europe/Berlin",
              $weekStart: "sun",
              $as: "week",
            },
            { $bucket: "day", $field: "closedAt" },
            { $fn: "count", $field: "*", $as: "n" },
          ],
          $groupBy: ["status", "week", "day_closedAt"],
        },
      });
      expectTypeOf(rows).resolves.toEqualTypeOf<
        Array<{ status: string } & { n: number } & { week: string; day_closedAt: string | null }>
      >();

      void c.aggregate({
        controls: {
          $select: [{ $bucket: "month", $field: "openedAt", $as: "m" }],
          // @ts-expect-error — neither a field nor a bucket alias
          $groupBy: ["mm"],
        },
      });
    }
  });

  it("serializes the object form to the bucket(...) URL grammar", async () => {
    const fetchFn = mockFetch([{ status: "open", week: "2026-03-22", n: 4 }]);
    const client = new Client<typeof Ticket>("/api/tickets", { fetch: fetchFn });
    const rows = await client.aggregate({
      controls: {
        $select: [
          {
            $bucket: "week",
            $field: "openedAt",
            $tz: "Europe/Berlin",
            $weekStart: "sun",
            $as: "week",
          },
          "status",
          { $fn: "count", $field: "*", $as: "n" },
        ],
        $groupBy: ["week", "status"],
      },
    });
    const url = decodeURIComponent(fetchFn.mock.calls[0]![0] as string);
    expect(url).toContain(
      "$select=bucket(openedAt,week,'Europe/Berlin',sun):week,status,count(*):n",
    );
    expect(url).toContain("$groupBy=week,status");
    expect(rows).toEqual([{ status: "open", week: "2026-03-22", n: 4 }]);
  });

  it("re-exports the gap-fill helpers", () => {
    expect(nextBucketLabel("2026-02-28", "day")).toBe("2026-03-01");
    expect(nextBucketLabel("2026-12-01", "month")).toBe("2027-01-01");
    expect(bucketStartInstant("2026-03-29", "UTC")).toBe(Date.UTC(2026, 2, 29));
  });

  it("hour buckets (since 0.1.147): typed as a label, serialized, gap-filled per zone", async () => {
    const fetchFn = mockFetch([{ h: "2026-03-29T01", n: 2 }]);
    const client = new Client<typeof Ticket>("/api/tickets", { fetch: fetchFn });
    const rows = await client.aggregate({
      controls: {
        $select: [
          { $bucket: "hour", $field: "openedAt", $tz: "Europe/Berlin", $as: "h" },
          { $fn: "count", $field: "*", $as: "n" },
        ],
        $groupBy: ["h"],
      },
    });
    expectTypeOf(rows[0]!.h).toEqualTypeOf<string>();
    expectTypeOf(rows[0]!.n).toEqualTypeOf<number>();
    const url = decodeURIComponent(fetchFn.mock.calls[0]![0] as string);
    expect(url).toContain("$select=bucket(openedAt,hour,'Europe/Berlin'):h,count(*):n");
    // the Berlin spring-forward skips 02:00–03:00 local: with the zone, gap-fill skips it too
    const options: NextBucketOptions = { tz: "Europe/Berlin" };
    expect(nextBucketLabel(rows[0]!.h, "hour", options)).toBe("2026-03-29T03");
    expect(nextBucketLabel(rows[0]!.h, "hour")).toBe("2026-03-29T02");
    expect(bucketStartInstant("2026-03-29T03", "Europe/Berlin")).toBe(Date.UTC(2026, 2, 29, 1));
  });
});

function shouldRun(): true {
  return true;
}
