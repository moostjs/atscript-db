import { describe, it, expect, beforeAll } from "vite-plus/test";
import { DbSpace } from "@atscript/db";

import { MongoAdapter } from "../mongo-adapter";
import { buildViewPipeline } from "../mongo-view-pipeline";
import { prepareFixtures } from "./test-utils";

// The pipelines and viewOn of every pre-existing managed view fixture, captured
// from the 0.1.140 build (packages/db-mongo/dist) — views without aliases or
// view sources must render byte-identically after 0.1.141, and the render
// revision stays "2" (no blanket recreate on upgrade).

const PINNED_0_1_140: Record<string, { viewOn: string; pipeline: unknown[] }> = {
  MvCustomerByCode: {
    viewOn: "mv_customers",
    pipeline: [
      {
        $lookup: {
          from: "mv_regions",
          let: {
            v0: "$code",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    {
                      $gt: ["$code", null],
                    },
                    {
                      $gt: ["$$v0", null],
                    },
                    {
                      $eq: ["$code", "$$v0"],
                    },
                  ],
                },
              },
            },
          ],
          as: "__joined_mv_regions",
        },
      },
      {
        $unwind: {
          path: "$__joined_mv_regions",
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $project: {
          _id: 0,
          id: "$id",
          regionName: "$__joined_mv_regions.name",
        },
      },
    ],
  },
  MvCustomerEligible: {
    viewOn: "mv_customers",
    pipeline: [
      {
        $lookup: {
          from: "mv_regions",
          let: {
            v0: "$regionId",
            v1: "$score",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    {
                      $and: [
                        {
                          $gt: ["$id", null],
                        },
                        {
                          $gt: ["$$v0", null],
                        },
                        {
                          $eq: ["$id", "$$v0"],
                        },
                      ],
                    },
                    {
                      $and: [
                        {
                          $gt: ["$minScore", null],
                        },
                        {
                          $gt: ["$$v1", null],
                        },
                        {
                          $lte: ["$minScore", "$$v1"],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
          as: "__joined_mv_regions",
        },
      },
      {
        $unwind: {
          path: "$__joined_mv_regions",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          _id: 0,
          id: "$id",
          regionName: {
            $ifNull: ["$__joined_mv_regions.name", null],
          },
        },
      },
    ],
  },
  MvCustomerGeo: {
    viewOn: "mv_customers",
    pipeline: [
      {
        $lookup: {
          from: "mv_regions",
          localField: "regionId",
          foreignField: "id",
          as: "__joined_mv_regions",
        },
      },
      {
        $unwind: {
          path: "$__joined_mv_regions",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: "mv_countries",
          localField: "__joined_mv_regions.countryId",
          foreignField: "id",
          as: "__joined_mv_countries",
        },
      },
      {
        $unwind: {
          path: "$__joined_mv_countries",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          _id: 0,
          id: "$id",
          regionName: {
            $ifNull: ["$__joined_mv_regions.name", null],
          },
          countryName: {
            $ifNull: ["$__joined_mv_countries.name", null],
          },
        },
      },
    ],
  },
  MvCustomerOrders: {
    viewOn: "mv_customers",
    pipeline: [
      {
        $lookup: {
          from: "mv_orders",
          let: {
            v0: "$id",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    {
                      $and: [
                        {
                          $gt: ["$customerId", null],
                        },
                        {
                          $gt: ["$$v0", null],
                        },
                        {
                          $eq: ["$customerId", "$$v0"],
                        },
                      ],
                    },
                    {
                      $in: ["$status", ["paid", "shipped"]],
                    },
                  ],
                },
              },
            },
          ],
          as: "__joined_mv_orders",
        },
      },
      {
        $unwind: {
          path: "$__joined_mv_orders",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $group: {
          _id: {
            city: "$profile.city",
          },
          orders: {
            $sum: {
              $cond: [
                {
                  $gt: ["$__joined_mv_orders.id", null],
                },
                1,
                0,
              ],
            },
          },
          total: {
            $sum: "$__joined_mv_orders.amount",
          },
          customers: {
            $sum: 1,
          },
        },
      },
      {
        $match: {
          customers: {
            $gt: 0,
          },
        },
      },
      {
        $project: {
          _id: 0,
          city: "$_id.city",
          orders: "$orders",
          total: "$total",
          customers: "$customers",
        },
      },
    ],
  },
  MvFilterOps: {
    viewOn: "mv_customers",
    pipeline: [
      {
        $match: {
          $and: [
            {
              code: {
                $ne: null,
              },
            },
            {
              regionId: null,
            },
            {
              $expr: {
                $and: [
                  {
                    $gt: ["$score", null],
                  },
                  {
                    $gt: ["$regionId", null],
                  },
                  {
                    $gt: ["$score", "$regionId"],
                  },
                ],
              },
            },
            {
              full_name: {
                $regex: "^a",
                $options: "i",
              },
            },
          ],
        },
      },
      {
        $project: {
          _id: 0,
          id: "$id",
        },
      },
    ],
  },
  MvOrdersInner: {
    viewOn: "mv_orders",
    pipeline: [
      {
        $lookup: {
          from: "mv_customers",
          localField: "customerId",
          foreignField: "id",
          as: "__joined_mv_customers",
        },
      },
      {
        $unwind: {
          path: "$__joined_mv_customers",
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $project: {
          _id: 0,
          id: "$id",
          customerName: "$__joined_mv_customers.full_name",
        },
      },
    ],
  },
  MvOrdersLeft: {
    viewOn: "mv_orders",
    pipeline: [
      {
        $lookup: {
          from: "mv_customers",
          localField: "customerId",
          foreignField: "id",
          as: "__joined_mv_customers",
        },
      },
      {
        $unwind: {
          path: "$__joined_mv_customers",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $match: {
          status: {
            $ne: "void",
          },
        },
      },
      {
        $project: {
          _id: 0,
          id: "$id",
          customerName: {
            $ifNull: ["$__joined_mv_customers.full_name", null],
          },
          city: {
            $ifNull: ["$__joined_mv_customers.profile.city", null],
          },
        },
      },
    ],
  },
  MvStoreZips: {
    viewOn: "mv_stores",
    pipeline: [
      {
        $match: {
          $and: [
            {
              "address.zip": {
                $ne: null,
              },
            },
            {
              $expr: {
                $and: [
                  {
                    $gt: ["$qty", null],
                  },
                  {
                    $gt: ["$cap", null],
                  },
                  {
                    $gt: ["$qty", "$cap"],
                  },
                ],
              },
            },
          ],
        },
      },
      {
        $project: {
          _id: 0,
          id: "$id",
          zip: {
            $ifNull: ["$address.zip", null],
          },
        },
      },
    ],
  },
  MvZipStats: {
    viewOn: "mv_stores",
    pipeline: [
      {
        $group: {
          _id: {
            city: "$address.city",
          },
          zips: {
            $addToSet: {
              $ifNull: ["$address.zip", "$$REMOVE"],
            },
          },
        },
      },
      {
        $addFields: {
          zips: {
            $size: "$zips",
          },
        },
      },
      {
        $project: {
          _id: 0,
          city: "$_id.city",
          zips: "$zips",
        },
      },
    ],
  },
  ViTaskList: {
    viewOn: "vi_tasks",
    pipeline: [
      {
        $project: {
          _id: 0,
          id: "$id",
          title: "$title",
        },
      },
    ],
  },
};

let views: Record<string, any>;
let ignore: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  views = await import("./fixtures/views.as");
  ignore = await import("./fixtures/view-ignore.as");
});

describe("MongoDB view pipelines — unchanged for pre-existing views (0.1.141)", () => {
  it("renders every 0.1.140 fixture pipeline byte-identically and keeps viewRenderRevision 2", () => {
    const space = new DbSpace(() => new MongoAdapter({} as never));
    for (const [name, pinned] of Object.entries(PINNED_0_1_140)) {
      const view = space.getView(views[name] ?? ignore[name]);
      expect(view.viewPlan.entryTable, name).toBe(pinned.viewOn);
      expect(JSON.stringify(buildViewPipeline(view)), name).toBe(JSON.stringify(pinned.pipeline));
      expect(view.dbAdapter.viewRenderRevision()).toBe("2");
    }
  });
});
