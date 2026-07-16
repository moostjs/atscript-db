import { describe, it, expect, beforeAll } from "vite-plus/test";

import { prepareFixtures } from "./test-utils";

let AnalyticsEvent: any;
let DefaultSpaceUser: any;

beforeAll(async () => {
  await prepareFixtures();
  const fixtures = await import("./fixtures/space-table.as");
  AnalyticsEvent = fixtures.AnalyticsEvent;
  DefaultSpaceUser = fixtures.DefaultSpaceUser;
});

/**
 * `@db.space` compiles through the real parser (an unknown annotation would
 * fail fixture compilation) and lands in runtime metadata, where the manifest
 * generator and `@TableController` token binding read it.
 */
describe("@db.space annotation", () => {
  it("lands in runtime metadata", () => {
    expect(AnalyticsEvent.metadata.get("db.space")).toBe("analytics");
  });

  it("is absent when not annotated (default space)", () => {
    expect(DefaultSpaceUser.metadata.has("db.space")).toBe(false);
  });
});
