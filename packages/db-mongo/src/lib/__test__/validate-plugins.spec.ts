import { ObjectId } from "mongodb";
import { describe, beforeAll, it, expect } from "vite-plus/test";

import { validateMongoIdPlugin } from "../validate-plugins.js";
import { prepareFixtures } from "./test-utils";

const dummyId = "a".repeat(24);

describe("mongo validate plugins", () => {
  beforeAll(prepareFixtures);
  it("must pass ObjectId", async () => {
    const { IdPlugin } = await import("./fixtures/plugins.as");
    const validator = IdPlugin.validator({
      plugins: [validateMongoIdPlugin],
    });
    expect(() =>
      validator.validate({
        _id: "a",
      }),
    ).toThrowError();
    expect(() =>
      validator.validate({
        _id: dummyId,
      }),
    ).not.toThrowError();
    expect(() =>
      validator.validate({
        _id: new ObjectId(),
      }),
    ).not.toThrowError();
  });

  it("must validate unique array items on string array (built-in validator)", async () => {
    const { UniqueItems } = await import("./fixtures/plugins.as");
    const validator = UniqueItems.validator();
    expect(() =>
      validator.validate({
        _id: dummyId,
        str: ["0", "0"],
      }),
    ).not.toThrowError();
    expect(() =>
      validator.validate({
        _id: dummyId,
        strUnique: ["0", "0"],
      }),
    ).toThrowError();
  });

  it("must validate unique array items on objects array (built-in validator)", async () => {
    const { UniqueItems } = await import("./fixtures/plugins.as");
    const validator = UniqueItems.validator();
    expect(() =>
      validator.validate({
        _id: dummyId,
        obj: [
          { a: "1", b: "a" },
          { a: "1", b: "a" },
        ],
      }),
    ).not.toThrowError();
    expect(() =>
      validator.validate({
        _id: dummyId,
        obj: [
          { a: "1", b: "a" },
          { a: "1", b: "b" },
        ],
      }),
    ).not.toThrowError();
    expect(() =>
      validator.validate({
        _id: dummyId,
        objUnique: [
          { a: "1", b: "a" },
          { a: "1", b: "a" },
        ],
      }),
    ).toThrowError();
  });

  it("must validate unique array items on objects array with defined key (built-in validator)", async () => {
    const { UniqueItems } = await import("./fixtures/plugins.as");
    const validator = UniqueItems.validator();

    expect(() =>
      validator.validate({
        _id: dummyId,
        kObj: [
          { a: "1", b: "a" },
          { a: "2", b: "a" },
        ],
      }),
    ).not.toThrowError();
    expect(() =>
      validator.validate({
        _id: dummyId,
        kObj: [
          { a: "1", b: "a" },
          { a: "1", b: "a" },
        ],
      }),
    ).toThrowError();
    expect(() =>
      validator.validate({
        _id: dummyId,
        kObj: [
          { a: "1", b: "a" },
          { a: "1", b: "b" },
        ],
      }),
    ).toThrowError();
  });
});
