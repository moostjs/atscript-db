import { type DbValidationContext, DbSpace } from "@atscript/db";
import { ObjectId } from "mongodb";
// oxlint-disable max-lines
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { CollectionPatcher } from "../../lib/collection-patcher";
import { MongoAdapter } from "../../lib/mongo-adapter";
import { createTestSpace, prepareFixtures } from "./test-utils";

const mongo = createTestSpace();

/**
 * Helper: validates + prepares insert payload (replaces AsCollection.prepareInsert)
 */
function prepareInsert(mongo: DbSpace, type: any, payload: any) {
  const table = mongo.getTable(type);
  const adapter = mongo.getAdapter(type) as unknown as MongoAdapter;
  const v = table.getValidator("insert")!;
  const ctx: DbValidationContext = { mode: "insert" };
  const arr = Array.isArray(payload) ? payload : [payload];
  const prepared = [] as any[];
  for (const item of arr) {
    if (v.validate(item, false, ctx)) {
      const data = { ...(item as Record<string, unknown>) };
      if (data._id) {
        data._id = adapter.prepareIdFromIdType(data._id as string);
      } else if (adapter.idType !== "objectId") {
        throw new Error('Missing "_id" field');
      }
      prepared.push(data);
    } else {
      throw new Error("Invalid payload");
    }
  }
  return prepared.length === 1 ? prepared[0] : prepared;
}

/**
 * Helper: validates + prepares replace payload (replaces AsCollection.prepareReplace)
 */
function prepareReplace(mongo: DbSpace, type: any, payload: any) {
  const table = mongo.getTable(type);
  const adapter = mongo.getAdapter(type) as unknown as MongoAdapter;
  const v = table.getValidator("update")!;
  if (v.validate(payload)) {
    const _id = adapter.prepareIdFromIdType((payload as Record<string, unknown>)._id as string);
    const data = { ...(payload as Record<string, unknown>), _id };
    return {
      toArgs: () => [{ _id }, data, {}] as const,
      filter: { _id },
      updateFilter: data,
      updateOptions: {},
    };
  }
  throw new Error("Invalid payload");
}

/**
 * Helper: validates + prepares update/patch payload (replaces AsCollection.prepareUpdate)
 */
function prepareUpdate(mongo: DbSpace, type: any, payload: any) {
  const table = mongo.getTable(type);
  const adapter = mongo.getAdapter(type) as unknown as MongoAdapter;
  const v = table.getValidator("bulkUpdate")!;
  if (v.validate(payload, false, { mode: "patch", flatMap: table.flatMap })) {
    return new CollectionPatcher(adapter.getPatcherContext(), payload).preparePatch();
  }
  throw new Error("Invalid payload");
}

describe("[mongo] AsCollection with structures", () => {
  beforeAll(prepareFixtures);
  it("[INSERT] checks _id as ObjectId", async () => {
    const { MinimalCollection } = await import("./fixtures/simple-collection.as");
    expect(() =>
      prepareInsert(mongo, MinimalCollection, {
        _id: new ObjectId(),
        name: "John Doe",
      }),
    ).not.toThrowError();
    expect(() =>
      prepareInsert(mongo, MinimalCollection, {
        _id: "a".repeat(24),
        name: "John Doe",
      }),
    ).not.toThrowError();
    expect(() =>
      prepareInsert(mongo, MinimalCollection, {
        _id: "a", // bad ObjectId
        name: "John Doe",
      }),
    ).toThrowError();
    expect(() =>
      prepareInsert(mongo, MinimalCollection, {
        // allow ObjectId to be empty for autogeneration
        name: "John Doe",
      }),
    ).not.toThrowError();
  });
  it("[INSERT] checks _id as string", async () => {
    const { MinimalCollectionString } = await import("./fixtures/simple-collection.as");
    expect(() =>
      prepareInsert(mongo, MinimalCollectionString, {
        _id: new ObjectId(),
        name: "John Doe",
      }),
    ).toThrowError();
    expect(() =>
      prepareInsert(mongo, MinimalCollectionString, {
        _id: "a".repeat(24),
        name: "John Doe",
      }),
    ).not.toThrowError();
    expect(() =>
      prepareInsert(mongo, MinimalCollectionString, {
        name: "John Doe",
      }),
    ).toThrowError();
  });

  it("[UPDATE] checks _id as ObjectId", async () => {
    const { MinimalCollection } = await import("./fixtures/simple-collection.as");
    expect(() =>
      prepareReplace(mongo, MinimalCollection, {
        _id: new ObjectId(),
        name: "John Doe",
      }),
    ).not.toThrowError();
    expect(() =>
      prepareReplace(mongo, MinimalCollection, {
        _id: "a".repeat(24),
        name: "John Doe",
      }),
    ).not.toThrowError();
    expect(() =>
      prepareReplace(mongo, MinimalCollection, {
        _id: "a", // bad ObjectId
        name: "John Doe",
      }),
    ).toThrowError();
    expect(() =>
      prepareReplace(mongo, MinimalCollection, {
        name: "John Doe",
      }),
    ).toThrowError();
  });
  it("[UPDATE] checks _id as string", async () => {
    const { MinimalCollectionString } = await import("./fixtures/simple-collection.as");
    expect(() =>
      prepareReplace(mongo, MinimalCollectionString, {
        _id: new ObjectId(),
        name: "John Doe",
      }),
    ).toThrowError();
    expect(() =>
      prepareReplace(mongo, MinimalCollectionString, {
        _id: "a".repeat(24),
        name: "John Doe",
      }),
    ).not.toThrowError();
    expect(() =>
      prepareReplace(mongo, MinimalCollectionString, {
        name: "John Doe",
      }),
    ).toThrowError();
  });

  it("[MERGE] checks _id as ObjectId", async () => {
    const { MinimalCollection } = await import("./fixtures/simple-collection.as");
    expect(() =>
      prepareUpdate(mongo, MinimalCollection, {
        _id: new ObjectId(),
        name: "John Doe",
      }),
    ).not.toThrowError();
    expect(() =>
      prepareUpdate(mongo, MinimalCollection, {
        _id: "a".repeat(24),
        name: "John Doe",
      }),
    ).not.toThrowError();
    expect(() =>
      prepareUpdate(mongo, MinimalCollection, {
        _id: "a", // bad ObjectId

        name: "John Doe",
      }),
    ).toThrowError();
    // Without _id: validation passes (partial mode); PK enforcement is at the db-table level
    expect(() =>
      prepareUpdate(mongo, MinimalCollection, {
        name: "John Doe",
      }),
    ).not.toThrowError();
  });
  it("[MERGE] checks _id as string", async () => {
    const { MinimalCollectionString } = await import("./fixtures/simple-collection.as");
    expect(() =>
      prepareUpdate(mongo, MinimalCollectionString, {
        _id: new ObjectId(),
        name: "John Doe",
      }),
    ).toThrowError();
    expect(() =>
      prepareUpdate(mongo, MinimalCollectionString, {
        _id: "a".repeat(24),
        name: "John Doe",
      }),
    ).not.toThrowError();
    // Without _id: validation passes (partial mode); PK enforcement is at the db-table level
    expect(() =>
      prepareUpdate(mongo, MinimalCollectionString, {
        name: "John Doe",
      }),
    ).not.toThrowError();
  });

  it("prepares simple patch query", async () => {
    const { SimpleCollection } = await import("./fixtures/simple-collection.as");
    expect(
      prepareUpdate(mongo, SimpleCollection, {
        _id: new ObjectId(),
        name: "John Doe",
        age: 25,
      }).updateFilter,
    ).toEqual([
      {
        $set: { name: "John Doe", age: 25 },
      },
    ]);
  });

  it("prepares simple patch with merge object", async () => {
    const { SimpleCollection } = await import("./fixtures/simple-collection.as");
    expect(
      prepareUpdate(mongo, SimpleCollection, {
        _id: new ObjectId(),
        name: "John Doe",
        age: 25,
        contacts: { email: "test@email.com" },
      }).updateFilter,
    ).toEqual([
      {
        $set: { name: "John Doe", age: 25, "contacts.email": "test@email.com" },
      },
    ]);
  });

  it("prepares simple patch replacing nested object with replace strategy", async () => {
    const { SimpleCollection } = await import("./fixtures/simple-collection.as");
    expect(
      () =>
        prepareUpdate(mongo, SimpleCollection, {
          _id: new ObjectId(),
          address: { line1: "123 Main St" },
        }).updateFilter,
    ).toThrowError(); // replace strategy is not deep partial
    expect(
      prepareUpdate(mongo, SimpleCollection, {
        _id: new ObjectId(),
        name: "John Doe",
        age: 25,
        address: { line1: "123 Main St", city: "New York", state: "New York", zip: "12332" },
      }).updateFilter,
    ).toEqual([
      {
        $set: {
          name: "John Doe",
          age: 25,
          address: { line1: "123 Main St", city: "New York", state: "New York", zip: "12332" },
        },
      },
    ]);
  });
  it("prepares simple patch replacing nested object with replace strategy and merging nested object with merge strategy", async () => {
    const { SimpleCollection } = await import("./fixtures/simple-collection.as");
    expect(
      prepareUpdate(mongo, SimpleCollection, {
        _id: new ObjectId(),
        name: "John Doe",
        age: 25,
        address: { line1: "123 Main St", city: "New York", state: "New York", zip: "12332" },
        contacts: { email: "test@email.com" },
      }).updateFilter,
    ).toEqual([
      {
        $set: {
          name: "John Doe",
          age: 25,
          // replacing address
          address: { line1: "123 Main St", city: "New York", state: "New York", zip: "12332" },
          // merging contacts
          "contacts.email": "test@email.com",
        },
      },
    ]);
  });
  it("prepares simple patch for deeply nested structure with mixed strategies", async () => {
    const { SimpleCollection } = await import("./fixtures/simple-collection.as");
    expect(
      prepareUpdate(mongo, SimpleCollection, {
        _id: new ObjectId(),
        nested: {
          nested1: { a: 5 },
          nested2: { c: 5 },
        },
      }).updateFilter,
    ).toEqual([
      {
        $set: {
          "nested.nested1": { a: 5 },
          "nested.nested2.c": 5,
        },
      },
    ]);
  });
});

describe("[mongo] AsCollection with arrays", () => {
  beforeAll(prepareFixtures);
  it("[PRIMITIVE] replace array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      primitive: {
        $replace: ["a", "b"],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "primitive": [
              "a",
              "b",
            ],
          },
        },
      ]
    `);
  });

  it("[COMPLEX PRIMITIVE] replace array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      primitiveComplex: {
        $replace: ["a", "b"],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "primitiveComplex": [
              "a",
              "b",
            ],
          },
        },
      ]
    `);
  });

  it("[PRIMITIVE] append array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      primitive: {
        $insert: ["a", "b"],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "primitive": {
              "$concatArrays": [
                {
                  "$ifNull": [
                    "$primitive",
                    [],
                  ],
                },
                [
                  "a",
                  "b",
                ],
              ],
            },
          },
        },
      ]
    `);
  });

  it("[PRIMITIVE] merge array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      primitive: {
        $update: ["a", "b"],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "primitive": {
              "$setUnion": [
                {
                  "$ifNull": [
                    "$primitive",
                    [],
                  ],
                },
                [
                  "a",
                  "b",
                ],
              ],
            },
          },
        },
      ]
    `);
  });

  it("[PRIMITIVE] remove array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      primitive: {
        $remove: ["a", "b"],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "primitive": {
              "$setDifference": [
                {
                  "$ifNull": [
                    "$primitive",
                    [],
                  ],
                },
                [
                  "a",
                  "b",
                ],
              ],
            },
          },
        },
      ]
    `);
  });

  // Array with key
  it("[OBJECT_WITH_KEY] replace array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");

    // "$replace" always requires all required fields to be present
    expect(() =>
      prepareUpdate(mongo, ArraysCollection, {
        _id: new ObjectId(),
        withKey: {
          $replace: [
            {
              key1: "1",
              key2: "2",
              // missing required prop "value"
              attribute: "123",
            },
          ],
        },
      }),
    ).toThrowError();

    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withKey: {
        $replace: [
          {
            key1: "1",
            key2: "2",
            value: "a",
            attribute: "123",
          },
        ],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withKey": [
              {
                "attribute": "123",
                "key1": "1",
                "key2": "2",
                "value": "a",
              },
            ],
          },
        },
      ]
    `);
  });

  it("[OBJECT_WITH_KEY] append array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");

    // "$insert" always requires all required fields to be present
    expect(() =>
      prepareUpdate(mongo, ArraysCollection, {
        _id: new ObjectId(),
        withKey: {
          $insert: [
            {
              key1: "1",
              key2: "2",
              // missing required prop "value"
              attribute: "123",
            },
          ],
        },
      }),
    ).toThrowError();

    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withKey: {
        $insert: [
          {
            key1: "1",
            key2: "2",
            value: "a",
            attribute: "123",
          },
        ],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withKey": {
              "$reduce": {
                "in": {
                  "$let": {
                    "in": {
                      "$concatArrays": [
                        {
                          "$filter": {
                            "as": "el",
                            "cond": {
                              "$not": {
                                "$and": [
                                  {
                                    "$eq": [
                                      "$$el.key1",
                                      "$$cand.key1",
                                    ],
                                  },
                                  {
                                    "$eq": [
                                      "$$el.key2",
                                      "$$cand.key2",
                                    ],
                                  },
                                ],
                              },
                            },
                            "input": "$$acc",
                          },
                        },
                        [
                          "$$cand",
                        ],
                      ],
                    },
                    "vars": {
                      "acc": "$$value",
                      "cand": "$$this",
                    },
                  },
                },
                "initialValue": {
                  "$ifNull": [
                    "$withKey",
                    [],
                  ],
                },
                "input": [
                  {
                    "attribute": "123",
                    "key1": "1",
                    "key2": "2",
                    "value": "a",
                  },
                ],
              },
            },
          },
        },
      ]
    `);
  });

  it("[OBJECT_WITH_KEY] merge array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");

    // "$update" + replace strategy => all required fields must be present
    expect(() =>
      prepareUpdate(mongo, ArraysCollection, {
        _id: new ObjectId(),
        withKey: {
          $update: [
            {
              key1: "1",
              key2: "2",
              // missing required prop "value"
              attribute: "123",
            },
          ],
        },
      }),
    ).toThrowError();

    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withKey: {
        $update: [
          {
            key1: "1",
            key2: "2",
            value: "a",
            attribute: "555",
          },
          {
            key1: "3",
            key2: "4",
            value: "b",
            attribute: "666",
          },
        ],
      },
    }).toArgs();

    expect(result[1]).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withKey": {
              "$reduce": {
                "in": {
                  "$map": {
                    "as": "el",
                    "in": {
                      "$cond": [
                        {
                          "$and": [
                            {
                              "$eq": [
                                "$$el.key1",
                                "$$this.key1",
                              ],
                            },
                            {
                              "$eq": [
                                "$$el.key2",
                                "$$this.key2",
                              ],
                            },
                          ],
                        },
                        "$$this",
                        "$$el",
                      ],
                    },
                    "input": "$$value",
                  },
                },
                "initialValue": {
                  "$ifNull": [
                    "$withKey",
                    [],
                  ],
                },
                "input": [
                  {
                    "attribute": "555",
                    "key1": "1",
                    "key2": "2",
                    "value": "a",
                  },
                  {
                    "attribute": "666",
                    "key1": "3",
                    "key2": "4",
                    "value": "b",
                  },
                ],
              },
            },
          },
        },
      ]
    `);
    expect(result[2]).toMatchInlineSnapshot(`{}`);
  });

  it("[OBJECT_WITH_KEY] remove array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");

    // "$remove" with keys => only keys are required
    expect(() =>
      prepareUpdate(mongo, ArraysCollection, {
        _id: new ObjectId(),
        withKey: {
          $remove: [
            {
              key1: "1",
              key2: "2",
            },
          ],
        },
      }),
    ).not.toThrowError();

    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withKey: {
        $remove: [
          {
            key1: "1",
            key2: "2",
            attribute: "555",
          },
          {
            key1: "3",
            key2: "4",
          },
        ],
      },
    }).toArgs();

    expect(result[1]).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withKey": {
              "$let": {
                "in": {
                  "$filter": {
                    "as": "el",
                    "cond": {
                      "$not": {
                        "$anyElementTrue": {
                          "$map": {
                            "as": "r",
                            "in": {
                              "$and": [
                                {
                                  "$eq": [
                                    "$$el.key1",
                                    "$$r.key1",
                                  ],
                                },
                                {
                                  "$eq": [
                                    "$$el.key2",
                                    "$$r.key2",
                                  ],
                                },
                              ],
                            },
                            "input": "$$rem",
                          },
                        },
                      },
                    },
                    "input": {
                      "$ifNull": [
                        "$withKey",
                        [],
                      ],
                    },
                  },
                },
                "vars": {
                  "rem": [
                    {
                      "attribute": "555",
                      "key1": "1",
                      "key2": "2",
                    },
                    {
                      "key1": "3",
                      "key2": "4",
                    },
                  ],
                },
              },
            },
          },
        },
      ]
    `);
    expect(result[2]).toEqual({});
  });

  it("[OBJECT_WITH_KEY_MERGE_STRATEGY] merge array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");

    // "$update" + merge strategy => only keys required
    expect(() =>
      prepareUpdate(mongo, ArraysCollection, {
        _id: new ObjectId(),
        withKeyMerge: {
          $update: [
            {
              key1: "1",
              key2: "2",
              // missing required props
            },
          ],
        },
      }),
    ).not.toThrowError();

    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withKeyMerge: {
        $update: [
          {
            key1: "1",
            key2: "2",
            attribute: "555",
          },
          {
            key1: "3",
            key2: "4",
            attribute: "666",
          },
        ],
      },
    }).toArgs();

    expect(result[1]).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withKeyMerge": {
              "$reduce": {
                "in": {
                  "$map": {
                    "as": "el",
                    "in": {
                      "$cond": [
                        {
                          "$and": [
                            {
                              "$eq": [
                                "$$el.key1",
                                "$$this.key1",
                              ],
                            },
                            {
                              "$eq": [
                                "$$el.key2",
                                "$$this.key2",
                              ],
                            },
                          ],
                        },
                        {
                          "$mergeObjects": [
                            "$$el",
                            "$$this",
                          ],
                        },
                        "$$el",
                      ],
                    },
                    "input": "$$value",
                  },
                },
                "initialValue": {
                  "$ifNull": [
                    "$withKeyMerge",
                    [],
                  ],
                },
                "input": [
                  {
                    "attribute": "555",
                    "key1": "1",
                    "key2": "2",
                  },
                  {
                    "attribute": "666",
                    "key1": "3",
                    "key2": "4",
                  },
                ],
              },
            },
          },
        },
      ]
    `);
    expect(result[2]).toMatchInlineSnapshot(`{}`);
  });

  // Array without key
  it("[OBJECT_WITHOUT_KEY] replace array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");

    // "$replace" always all required fields must be present
    expect(() =>
      prepareUpdate(mongo, ArraysCollection, {
        _id: new ObjectId(),
        withKeyMerge: {
          $replace: [
            {
              key1: "1",
              // missing required props
            },
          ],
        },
      }),
    ).toThrowError();

    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withoutKey: {
        $replace: [
          {
            key: "1",
            value: "a",
            attribute: "123",
          },
        ],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withoutKey": [
              {
                "attribute": "123",
                "key": "1",
                "value": "a",
              },
            ],
          },
        },
      ]
    `);
  });

  it("[OBJECT_WITHOUT_KEY] append array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");

    // "$insert" always all required fields must be present
    expect(() =>
      prepareUpdate(mongo, ArraysCollection, {
        _id: new ObjectId(),
        withKeyMerge: {
          $insert: [
            {
              key1: "1",
              // missing required props
            },
          ],
        },
      }),
    ).toThrowError();

    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withoutKey: {
        $insert: [
          {
            key: "1",
            value: "a",
            attribute: "123",
          },
        ],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withoutKey": {
              "$concatArrays": [
                {
                  "$ifNull": [
                    "$withoutKey",
                    [],
                  ],
                },
                [
                  {
                    "attribute": "123",
                    "key": "1",
                    "value": "a",
                  },
                ],
              ],
            },
          },
        },
      ]
    `);
  });

  it("[OBJECT_WITHOUT_KEY] merge array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");

    // "$update" + without key => all required fields must be present
    expect(() =>
      prepareUpdate(mongo, ArraysCollection, {
        _id: new ObjectId(),
        withKeyMerge: {
          $update: [
            {
              key1: "1",
              // missing required props
            },
          ],
        },
      }),
    ).toThrowError();

    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withoutKey: {
        $update: [
          {
            key: "1",
            value: "555",
          },
          {
            key: "2",
            value: "666",
          },
        ],
      },
    }).toArgs();

    expect(result[1]).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withoutKey": {
              "$setUnion": [
                {
                  "$ifNull": [
                    "$withoutKey",
                    [],
                  ],
                },
                [
                  {
                    "key": "1",
                    "value": "555",
                  },
                  {
                    "key": "2",
                    "value": "666",
                  },
                ],
              ],
            },
          },
        },
      ]
    `);
    expect(result[2]).toEqual({});
  });

  it("[OBJECT_WITHOUT_KEY] remove array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");

    // "$remove" without key => all required fields must be present
    expect(() =>
      prepareUpdate(mongo, ArraysCollection, {
        _id: new ObjectId(),
        withKeyMerge: {
          $remove: [
            {
              key1: "1",
              // missing required props
            },
          ],
        },
      }),
    ).toThrowError();

    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withoutKey: {
        $remove: [
          {
            key: "1",
            value: "555",
          },
          {
            key: "2",
            value: "666",
          },
        ],
      },
    }).toArgs();

    expect(result[1]).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withoutKey": {
              "$setDifference": [
                {
                  "$ifNull": [
                    "$withoutKey",
                    [],
                  ],
                },
                [
                  {
                    "key": "1",
                    "value": "555",
                  },
                  {
                    "key": "2",
                    "value": "666",
                  },
                ],
              ],
            },
          },
        },
      ]
    `);
    expect(result[2]).toEqual({});
  });
});

describe("[mongo] CollectionPatcher — $upsert", () => {
  beforeAll(prepareFixtures);

  it("[OBJECT_WITH_KEY] upsert keyed array", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withKey: {
        $upsert: [{ key1: "1", key2: "2", value: "new", attribute: "attr" }],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withKey": {
              "$reduce": {
                "in": {
                  "$let": {
                    "in": {
                      "$concatArrays": [
                        {
                          "$filter": {
                            "as": "el",
                            "cond": {
                              "$not": {
                                "$and": [
                                  {
                                    "$eq": [
                                      "$$el.key1",
                                      "$$cand.key1",
                                    ],
                                  },
                                  {
                                    "$eq": [
                                      "$$el.key2",
                                      "$$cand.key2",
                                    ],
                                  },
                                ],
                              },
                            },
                            "input": "$$acc",
                          },
                        },
                        [
                          "$$cand",
                        ],
                      ],
                    },
                    "vars": {
                      "acc": "$$value",
                      "cand": "$$this",
                    },
                  },
                },
                "initialValue": {
                  "$ifNull": [
                    "$withKey",
                    [],
                  ],
                },
                "input": [
                  {
                    "attribute": "attr",
                    "key1": "1",
                    "key2": "2",
                    "value": "new",
                  },
                ],
              },
            },
          },
        },
      ]
    `);
  });

  it("[OBJECT_WITHOUT_KEY] upsert without keys uses $setUnion", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withoutKey: {
        $upsert: [{ key: "a", value: "b", attribute: "c" }],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withoutKey": {
              "$setUnion": [
                {
                  "$ifNull": [
                    "$withoutKey",
                    [],
                  ],
                },
                [
                  {
                    "attribute": "c",
                    "key": "a",
                    "value": "b",
                  },
                ],
              ],
            },
          },
        },
      ]
    `);
  });

  it("[PRIMITIVE] upsert without keys uses $setUnion", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      primitive: {
        $upsert: ["x", "y"],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "primitive": {
              "$setUnion": [
                {
                  "$ifNull": [
                    "$primitive",
                    [],
                  ],
                },
                [
                  "x",
                  "y",
                ],
              ],
            },
          },
        },
      ]
    `);
  });
});

describe("[mongo] CollectionPatcher — single key", () => {
  beforeAll(prepareFixtures);

  it("[SINGLE_KEY] upsert produces bare $eq (no $and wrapper)", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      singleKey: {
        $upsert: [{ id: "1", value: "a" }],
      },
    }).updateFilter;

    // Single key should produce { $eq: [...] } instead of { $and: [{ $eq: [...] }] }
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "singleKey": {
              "$reduce": {
                "in": {
                  "$let": {
                    "in": {
                      "$concatArrays": [
                        {
                          "$filter": {
                            "as": "el",
                            "cond": {
                              "$not": {
                                "$eq": [
                                  "$$el.id",
                                  "$$cand.id",
                                ],
                              },
                            },
                            "input": "$$acc",
                          },
                        },
                        [
                          "$$cand",
                        ],
                      ],
                    },
                    "vars": {
                      "acc": "$$value",
                      "cand": "$$this",
                    },
                  },
                },
                "initialValue": {
                  "$ifNull": [
                    "$singleKey",
                    [],
                  ],
                },
                "input": [
                  {
                    "id": "1",
                    "value": "a",
                  },
                ],
              },
            },
          },
        },
      ]
    `);
  });

  it("[SINGLE_KEY] update produces bare $eq", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      singleKey: {
        $update: [{ id: "1", value: "updated" }],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "singleKey": {
              "$reduce": {
                "in": {
                  "$map": {
                    "as": "el",
                    "in": {
                      "$cond": [
                        {
                          "$eq": [
                            "$$el.id",
                            "$$this.id",
                          ],
                        },
                        "$$this",
                        "$$el",
                      ],
                    },
                    "input": "$$value",
                  },
                },
                "initialValue": {
                  "$ifNull": [
                    "$singleKey",
                    [],
                  ],
                },
                "input": [
                  {
                    "id": "1",
                    "value": "updated",
                  },
                ],
              },
            },
          },
        },
      ]
    `);
  });

  it("[SINGLE_KEY] remove produces bare $eq", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      singleKey: {
        $remove: [{ id: "1" }],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "singleKey": {
              "$let": {
                "in": {
                  "$filter": {
                    "as": "el",
                    "cond": {
                      "$not": {
                        "$anyElementTrue": {
                          "$map": {
                            "as": "r",
                            "in": {
                              "$eq": [
                                "$$el.id",
                                "$$r.id",
                              ],
                            },
                            "input": "$$rem",
                          },
                        },
                      },
                    },
                    "input": {
                      "$ifNull": [
                        "$singleKey",
                        [],
                      ],
                    },
                  },
                },
                "vars": {
                  "rem": [
                    {
                      "id": "1",
                    },
                  ],
                },
              },
            },
          },
        },
      ]
    `);
  });
});

describe("[mongo] CollectionPatcher — uniqueItems", () => {
  beforeAll(prepareFixtures);

  it("[UNIQUE_PRIMITIVE] $insert delegates to $setUnion", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      uniquePrimitive: {
        $insert: ["a", "b"],
      },
    }).updateFilter;

    // uniqueItems + $insert should use $setUnion (not $concatArrays)
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "uniquePrimitive": {
              "$setUnion": [
                {
                  "$ifNull": [
                    "$uniquePrimitive",
                    [],
                  ],
                },
                [
                  "a",
                  "b",
                ],
              ],
            },
          },
        },
      ]
    `);
  });

  it("[UNIQUE_OBJECTS] $insert delegates to $setUnion", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      uniqueObjects: {
        $insert: [{ name: "a", score: 1 }],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "uniqueObjects": {
              "$setUnion": [
                {
                  "$ifNull": [
                    "$uniqueObjects",
                    [],
                  ],
                },
                [
                  {
                    "name": "a",
                    "score": 1,
                  },
                ],
              ],
            },
          },
        },
      ]
    `);
  });
});

describe("[mongo] CollectionPatcher — withoutKeyMerge", () => {
  beforeAll(prepareFixtures);

  it("[WITHOUT_KEY_MERGE] $update uses $setUnion (no keys)", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withoutKeyMerge: {
        $update: [{ key: "1", value: "a", attribute: "x" }],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withoutKeyMerge": {
              "$setUnion": [
                {
                  "$ifNull": [
                    "$withoutKeyMerge",
                    [],
                  ],
                },
                [
                  {
                    "attribute": "x",
                    "key": "1",
                    "value": "a",
                  },
                ],
              ],
            },
          },
        },
      ]
    `);
  });

  it("[WITHOUT_KEY_MERGE] $remove uses $setDifference", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withoutKeyMerge: {
        $remove: [{ key: "1", value: "a", attribute: "x" }],
      },
    }).updateFilter;

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "withoutKeyMerge": {
              "$setDifference": [
                {
                  "$ifNull": [
                    "$withoutKeyMerge",
                    [],
                  ],
                },
                [
                  {
                    "attribute": "x",
                    "key": "1",
                    "value": "a",
                  },
                ],
              ],
            },
          },
        },
      ]
    `);
  });
});

describe("[mongo] CollectionPatcher — edge cases", () => {
  beforeAll(prepareFixtures);

  it("empty array operations are no-ops", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");

    // $insert with empty array
    const insertResult = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      primitive: {
        $insert: [],
      },
    }).updateFilter;
    expect(insertResult).toEqual([]);

    // $remove with empty array
    const removeResult = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      primitive: {
        $remove: [],
      },
    }).updateFilter;
    expect(removeResult).toEqual([]);

    // $upsert with empty array
    const upsertResult = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      primitive: {
        $upsert: [],
      },
    }).updateFilter;
    expect(upsertResult).toEqual([]);

    // $update with empty array
    const updateResult = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      primitive: {
        $update: [],
      },
    }).updateFilter;
    expect(updateResult).toEqual([]);
  });

  it("multiple operations on same array create separate pipeline stages", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      withKey: {
        $remove: [{ key1: "old", key2: "old" }],
        $insert: [{ key1: "new", key2: "new", value: "v", attribute: "a" }],
      },
    }).updateFilter;

    // $remove and $insert (→upsert) on same key should produce separate $set stages
    expect(result).toHaveLength(2);
    expect(result[0].$set).toHaveProperty("withKey");
    expect(result[1].$set).toHaveProperty("withKey");
  });

  it("multiple array fields in one patch", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      primitive: {
        $replace: ["a", "b"],
      },
      withoutKey: {
        $replace: [{ key: "1", value: "v" }],
      },
    }).updateFilter;

    // Both fields should appear in the same $set stage (no key collision)
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "$set": {
            "primitive": [
              "a",
              "b",
            ],
            "withoutKey": [
              {
                "key": "1",
                "value": "v",
              },
            ],
          },
        },
      ]
    `);
  });

  it("filter contains prepared _id", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const id = new ObjectId();
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: id,
      primitive: { $replace: ["x"] },
    });

    expect(result.filter).toEqual({ _id: id });
  });

  it("filter contains prepared string _id", async () => {
    const { MinimalCollectionString } = await import("./fixtures/simple-collection.as");
    const id = "a".repeat(24);
    const result = prepareUpdate(mongo, MinimalCollectionString, {
      _id: id,
      name: "test",
    });

    expect(result.filter).toEqual({ _id: id });
  });

  it("mixed scalar fields and array operations", async () => {
    const { ArraysCollection } = await import("./fixtures/arrays-collection.as");
    const result = prepareUpdate(mongo, ArraysCollection, {
      _id: new ObjectId(),
      primitive: {
        $replace: ["a"],
      },
      singleKey: {
        $upsert: [{ id: "1", value: "v" }],
      },
    }).updateFilter;

    // Different array fields should coexist in one $set stage
    expect(result).toHaveLength(1);
    expect(result[0].$set).toHaveProperty("primitive");
    expect(result[0].$set).toHaveProperty("singleKey");
  });
});
