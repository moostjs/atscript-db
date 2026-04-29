import { describe, it, expect, beforeAll } from "vite-plus/test";
import { serializeAnnotatedType, type TAtscriptAnnotatedType } from "@atscript/typescript/utils";

import type { MetaResponse } from "../types";
import type { TDbActionInfo } from "@atscript/db";
import { createClientValidator } from "../validator";

/**
 * The runtime side of `db-client` consumes `TMetaResponse` end-to-end after
 * the action-layer addition. This spec confirms the meta envelope is accepted
 * with the new `actions: TDbActionInfo[]` field (downstream validator
 * construction still succeeds).
 */

let UserType: TAtscriptAnnotatedType;
let serializedType: ReturnType<typeof serializeAnnotatedType>;

beforeAll(async () => {
  const fixtures = await import("./fixtures/test-table.as");
  UserType = fixtures.User as unknown as TAtscriptAnnotatedType;
  serializedType = serializeAnnotatedType(UserType, {
    processAnnotation: ({ key, value }) => {
      if (key.startsWith("meta.") || key.startsWith("expect.") || key.startsWith("db.rel.")) {
        return { key, value };
      }
      if (key === "db.json" || key === "db.patch.strategy" || key.startsWith("db.default")) {
        return { key, value };
      }
      if (key.startsWith("db.")) return undefined;
      return { key, value };
    },
  });
});

describe("MetaResponse with actions field", () => {
  it("createClientValidator accepts a meta payload that includes actions[]", () => {
    const actions: TDbActionInfo[] = [
      {
        name: "block",
        label: "Block",
        level: "row",
        processor: "backend",
        value: "/users/actions/block",
        icon: "i-as-block",
      },
      {
        name: "edit",
        label: "Edit",
        level: "row",
        processor: "navigate",
        value: "/users/$1/edit",
      },
      {
        name: "exportCsv",
        label: "Export CSV",
        level: "table",
        processor: "custom",
        value: "exportCsv",
      },
    ];
    const meta: MetaResponse = {
      searchable: false,
      vectorSearchable: false,
      searchIndexes: [],
      primaryKeys: ["id"],
      relations: [],
      fields: {},
      type: serializedType,
      actions,
      crud: {},
    };
    const validator = createClientValidator(meta);
    expect(validator).toBeDefined();
    expect(meta.actions).toHaveLength(3);
  });

  it("MetaResponse accepts an empty actions array", () => {
    const meta: MetaResponse = {
      searchable: false,
      vectorSearchable: false,
      searchIndexes: [],
      primaryKeys: ["id"],
      relations: [],
      fields: {},
      type: serializedType,
      actions: [],
      crud: {},
    };
    const validator = createClientValidator(meta);
    expect(validator).toBeDefined();
  });
});
