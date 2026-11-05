import { annotate } from "@atscript/typescript/utils";
import { describe, it, expect, beforeAll } from "vite-plus/test";

import { dbValidatorOptions, normalizeWritePayload } from "../validator";

import { prepareFixtures } from "./test-utils";

// `normalizeWritePayload` (since 0.1.170): the one normalizer the write paths
// and db-client share — pure, copy-on-change, patch operators walked.

let fx: Record<string, any>;

beforeAll(async () => {
  await prepareFixtures();
  fx = await import("./fixtures/normalize-writes.as");
});

const patch = (value: Record<string, unknown>) =>
  normalizeWritePayload(fx.NwUser, value, "patch", dbValidatorOptions(fx.NwUser, "patch"));

describe("normalizeWritePayload", () => {
  it("returns the same objects when nothing changes; never mutates the input", () => {
    const row = { email: "a@x", name: "A", labels: ["x"], profile: { city: "C" } };
    expect(normalizeWritePayload(fx.NwUser, row, "insert")).toBe(row);
    const p = { id: 1, labels: { $insert: ["y"] }, profile: { city: "C" } };
    expect(patch(p)).toBe(p);
    const input = { id: 1, name: " A ", profile: { city: " C " }, labels: ["b"] };
    const copy = structuredClone(input);
    const out = patch(input);
    expect(input).toEqual(copy);
    expect(out).toEqual({ id: 1, name: "A", profile: { city: "C" }, labels: ["b"] });
    // the untouched array is shared, not copied
    expect(out.labels).toBe(input.labels);
  });

  it("a type without normalizers returns the payload at once", () => {
    const p = { id: 1, ownerId: 2, $cas: { version: 1 } };
    expect(normalizeWritePayload(fx.NwUserTag, p, "patch")).toBe(p);
    expect(normalizeWritePayload(fx.NwUserTag, p, "insert")).toBe(p);
  });

  it("walks every array operator and the keys of $update / $remove", () => {
    expect(
      patch({
        labels: { $replace: [" A "], $insert: [" B "], $upsert: [" C "], $remove: [" D "] },
        contacts: { $update: [{ kind: " K ", value: " v " }], $remove: [{ kind: " Q " }] },
      }),
    ).toEqual({
      labels: { $replace: ["a"], $insert: ["b"], $upsert: ["c"], $remove: ["d"] },
      contacts: { $update: [{ kind: "k", value: "v" }], $remove: [{ kind: "q" }] },
    });
  });

  it("relations: FROM operands as rows / patches, a TO object as a patch, VIA items", () => {
    expect(
      patch({
        notes: { $insert: [{ title: " a " }], $update: [{ id: 1, title: " b " }] },
        tags: { $replace: [{ name: " T " }], $remove: [{ id: 3 }] },
      }),
    ).toEqual({
      notes: { $insert: [{ title: "a" }], $update: [{ id: 1, title: "b" }] },
      tags: { $replace: [{ name: "t" }], $remove: [{ id: 3 }] },
    });
    expect(
      normalizeWritePayload(
        fx.NwNote,
        { id: 1, owner: { name: " O ", labels: { $insert: [" L "] } } },
        "patch",
      ),
    ).toEqual({ id: 1, owner: { name: "O", labels: { $insert: ["l"] } } });
  });

  it("leaves field operators, unknown keys and $cas as they are", () => {
    const p = { id: 1, $cas: { version: 2 }, extra: " X ", name: { $inc: 1 } };
    expect(patch(p)).toBe(p);
  });

  it("judges a field value at its own path: an object union without a discriminator", () => {
    const opts = dbValidatorOptions(fx.NwContact, "patch");
    const out = normalizeWritePayload(
      fx.NwContact,
      { id: 1, contact: { value: "XYZ" } },
      "patch",
      opts,
    );
    // insert judges the same value the same way
    const inserted = normalizeWritePayload(
      fx.NwContact,
      { id: 1, contact: { value: "XYZ" } },
      "insert",
    );
    expect(out.contact).toEqual({ value: "xyz" });
    expect(inserted.contact).toEqual({ value: "xyz" });
  });

  it("sees a normalizer annotated at runtime after the first patch", () => {
    const meta = fx.NwPlain.type.props.get("label").metadata;
    expect(normalizeWritePayload(fx.NwPlain, { id: 1, label: " X " }, "patch")).toEqual({
      id: 1,
      label: " X ",
    });
    annotate(meta, "normalize.trim" as never, true as never);
    try {
      expect(normalizeWritePayload(fx.NwPlain, { id: 1, label: " X " }, "patch")).toEqual({
        id: 1,
        label: "X",
      });
    } finally {
      annotate(meta, "normalize.trim" as never, false as never);
    }
  });
});
