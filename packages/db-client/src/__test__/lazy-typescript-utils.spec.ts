import { describe, it, expect, vi } from "vite-plus/test";

// `@atscript/typescript/utils` is only needed to read an action's input form
// (and by the preflight validator, itself loaded on the first write). Importing
// the client must not load it, so it stays out of an app's first chunk.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@atscript/typescript/utils", async (importOriginal) => {
  loads.count++;
  return importOriginal();
});

describe("@atscript/typescript/utils is loaded on demand", () => {
  it("importing the client does not load it; getActionForm does", async () => {
    const { Client } = await import("../index");
    expect(loads.count).toBe(0);

    const serialized = {
      $v: 2,
      type: { kind: "object", props: {}, propsPatterns: [], tags: [] },
      metadata: {},
    };
    const fetch = vi.fn(async (url: string) => {
      const body = url.endsWith("/meta")
        ? {
            searchable: false,
            vectorSearchable: false,
            searchIndexes: [],
            type: serialized,
            primaryKeys: ["id"],
            readOnly: false,
            relations: [],
            fields: {},
            actions: [{ name: "invite", level: "table", inputForm: "Invite" }],
          }
        : serialized;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new Client("/api/users", { fetch: fetch as unknown as typeof globalThis.fetch });
    const form = await client.getActionForm("invite");
    expect(form?.type.kind).toBe("object");
    expect(loads.count).toBe(1);
  });
});
