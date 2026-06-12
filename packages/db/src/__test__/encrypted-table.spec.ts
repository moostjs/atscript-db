import { randomBytes } from "node:crypto";

import { describe, it, expect, beforeAll, beforeEach } from "vite-plus/test";

import { DbSpace } from "../table/db-space";
import { computeTableSnapshot } from "../schema/schema-hash";
import { MockAdapter, prepareFixtures } from "./test-utils";

const KEYS = { k1: randomBytes(32), k2: randomBytes(32) };
const ENVELOPE_RE = /^aes1\$[\w.-]+\$[\w-]+\$[\w-]+\$[\w-]+$/;

let EncPartner: any;

function makeSpace(encryption?: any) {
  return new DbSpace(() => new MockAdapter(), encryption ? { encryption } : undefined);
}

function encSpace(onUnencrypted?: "error" | "passthrough") {
  return makeSpace({ defaultKeyId: "k1", keys: KEYS, onUnencrypted });
}

beforeAll(async () => {
  await prepareFixtures();
  ({ EncPartner } = await import("./fixtures/encrypted-table.as"));
});

describe("@db.encrypted — metadata & field descriptors", () => {
  it("marks descriptors encrypted with text storage shape", () => {
    const table = encSpace().getTable(EncPartner);
    const byPath = new Map(table.fieldDescriptors.map((fd) => [fd.path, fd]));

    for (const path of ["apiToken", "creditCredentials", "pinCode", "isVip", "tags"]) {
      const fd = byPath.get(path)!;
      expect(fd, path).toBeDefined();
      expect(fd.encrypted, path).toBe(true);
      expect(fd.designType, path).toBe("string");
      expect(fd.storage, path).toBe("column");
    }
    // Plain fields untouched
    expect(byPath.get("legalName")!.encrypted).toBeUndefined();
    // Children of an encrypted object never become columns
    expect(byPath.has("creditCredentials.user")).toBe(false);
  });

  it("vetoes filter/sort capability via the adapter gate", () => {
    const table = encSpace().getTable(EncPartner);
    const fd = table.fieldDescriptors.find((f) => f.path === "apiToken")!;
    expect(table.canFilterField(fd)).toBe(false);
    expect(table.canSortField(fd)).toBe(false);
  });

  it("snapshots carry the encrypted flag (hash drift on toggle)", () => {
    const table = encSpace().getTable(EncPartner);
    table.getMetadata();
    const snapshot = computeTableSnapshot(table as any);
    const field = snapshot.fields.find((f) => f.physicalName === "apiToken")!;
    expect(field.encrypted).toBe(true);
    expect(field.designType).toBe("string");
  });
});

describe("@db.encrypted — config", () => {
  it("fails with ENC_CONFIG_MISSING when the space has no encryption config", async () => {
    const table = makeSpace().getTable(EncPartner);
    await expect(table.findMany({ filter: {}, controls: {} })).rejects.toMatchObject({
      code: "ENC_CONFIG_MISSING",
    });
  });

  it("fails with ENC_KEY_INVALID at DbSpace construction for bad keys", () => {
    expect(() => makeSpace({ defaultKeyId: "k1", keys: { k1: "short" } })).toThrow(
      expect.objectContaining({ code: "ENC_KEY_INVALID" }),
    );
  });
});

describe("@db.encrypted — transparent write/read round-trip", () => {
  let space: DbSpace;
  let table: any;
  let adapter: MockAdapter;

  beforeEach(() => {
    space = encSpace();
    table = space.getTable(EncPartner);
    adapter = space.getAdapter(EncPartner) as MockAdapter;
  });

  it("stores envelopes (raw storage has no plaintext), reads decrypt transparently", async () => {
    await table.insertOne({
      id: "p1",
      legalName: "Acme",
      apiToken: "secret-token",
      creditCredentials: { user: "cardholder-bravo", pwd: "passphrase-charlie" },
      pinCode: 1234,
      isVip: true,
      tags: ["gold-tier-delta", "eu-region-echo"],
    });

    // Raw storage assertion — read through the adapter store, bypassing the table.
    const raw = adapter.store.get("enc_partners")![0]!;
    for (const field of ["apiToken", "creditCredentials", "pinCode", "isVip", "tags"]) {
      expect(raw[field], field).toMatch(ENVELOPE_RE);
    }
    // Sentinels must be long enough that they can't collide with the random
    // base64url ciphertext by chance (a 2–4 char token like "u1"/"1234" hits
    // ~1-in-4 runs). pinCode/isVip are numeric/boolean — their encryption is
    // already proven by the ENVELOPE_RE check above and the round-trip below.
    const serialized = JSON.stringify(raw);
    for (const plaintext of [
      "secret-token",
      "passphrase-charlie",
      "cardholder-bravo",
      "gold-tier-delta",
      "eu-region-echo",
    ]) {
      expect(serialized).not.toContain(plaintext);
    }
    expect(raw.legalName).toBe("Acme");

    // Transparent decryption on read — type-exact round-trip.
    const row = await table.findOne({ filter: { id: "p1" }, controls: {} });
    expect(row.apiToken).toBe("secret-token");
    expect(row.creditCredentials).toEqual({ user: "cardholder-bravo", pwd: "passphrase-charlie" });
    expect(row.pinCode).toBe(1234);
    expect(row.isVip).toBe(true);
    expect(row.tags).toEqual(["gold-tier-delta", "eu-region-echo"]);
  });

  it("keeps absent optional encrypted props absent", async () => {
    await table.insertOne({ id: "p2", legalName: "NoSecrets" });
    const raw = adapter.store.get("enc_partners")![0]!;
    expect("apiToken" in raw).toBe(false);
    const row = await table.findOne({ filter: { id: "p2" }, controls: {} });
    expect(row.apiToken).toBeUndefined();
  });

  it("re-encrypts on update ($set-style assignment is allowed)", async () => {
    await table.insertOne({ id: "p3", legalName: "Acme", apiToken: "old" });
    const before = adapter.store.get("enc_partners")![0]!.apiToken;
    await table.updateOne({ id: "p3", apiToken: "new" });
    const call = adapter.calls.find((c) => c.method === "updateOne")!;
    expect(call.args[1].apiToken).toMatch(ENVELOPE_RE);
    expect(call.args[1].apiToken).not.toBe(before);
  });

  it("encrypts updateMany payloads too", async () => {
    await table.insertOne({ id: "p4", legalName: "A" });
    await table.updateMany({ legalName: "A" }, { apiToken: "rotated" });
    const call = adapter.calls.find((c) => c.method === "updateMany")!;
    expect(call.args[1].apiToken).toMatch(ENVELOPE_RE);
  });
});

describe("@db.encrypted — query/patch guards", () => {
  let table: any;

  beforeEach(() => {
    table = encSpace().getTable(EncPartner);
  });

  it("rejects filters referencing an encrypted field", async () => {
    await expect(table.findMany({ filter: { apiToken: "x" }, controls: {} })).rejects.toMatchObject(
      { code: "ENC_FIELD_FILTER" },
    );
  });

  it("rejects nested-path filters into an encrypted object", async () => {
    await expect(
      table.findMany({ filter: { "creditCredentials.user": "u" }, controls: {} }),
    ).rejects.toMatchObject({ code: "ENC_FIELD_FILTER" });
  });

  it("rejects encrypted refs inside $or / $and / $not", async () => {
    await expect(
      table.findMany({
        filter: { $or: [{ legalName: "x" }, { $not: { apiToken: "y" } }] },
        controls: {},
      }),
    ).rejects.toMatchObject({ code: "ENC_FIELD_FILTER" });
  });

  it("rejects $sort on an encrypted field", async () => {
    await expect(
      table.findMany({ filter: {}, controls: { $sort: { apiToken: 1 } } }),
    ).rejects.toMatchObject({ code: "ENC_FIELD_SORT" });
  });

  it("rejects $groupBy / aggregate refs on encrypted fields", async () => {
    await expect(
      table.aggregate({ filter: {}, controls: { $groupBy: ["apiToken"] } }),
    ).rejects.toMatchObject({ code: "ENC_FIELD_AGG" });
    await expect(
      table.aggregate({
        filter: {},
        controls: { $groupBy: ["legalName"], $select: [{ $fn: "max", $field: "pinCode" }] },
      }),
    ).rejects.toMatchObject({ code: "ENC_FIELD_AGG" });
  });

  it("rejects arithmetic patch ops on encrypted fields", async () => {
    await expect(table.updateOne({ id: "p1", pinCode: { $inc: 1 } })).rejects.toMatchObject({
      code: "ENC_FIELD_PATCH_OP",
    });
  });

  it("rejects array patch ops on encrypted fields", async () => {
    await expect(table.updateOne({ id: "p1", tags: { $insert: ["x"] } })).rejects.toMatchObject({
      code: "ENC_FIELD_PATCH_OP",
    });
  });

  it("rejects mutation filters referencing encrypted fields", async () => {
    await expect(table.deleteMany({ apiToken: "x" })).rejects.toMatchObject({
      code: "ENC_FIELD_FILTER",
    });
    await expect(table.updateMany({ apiToken: "x" }, { legalName: "y" })).rejects.toMatchObject({
      code: "ENC_FIELD_FILTER",
    });
  });
});

describe("@db.encrypted — onUnencrypted migration window", () => {
  function seedPlaintext(space: DbSpace) {
    const adapter = space.getAdapter(EncPartner) as MockAdapter;
    adapter.store.set("enc_partners", [
      { id: "legacy", legalName: "Old", apiToken: "plain-token" },
    ]);
    return space.getTable(EncPartner);
  }

  it("'error' (default): reading a plaintext value fails with ENC_NOT_ENCRYPTED", async () => {
    const table = seedPlaintext(encSpace());
    await expect(table.findOne({ filter: { id: "legacy" }, controls: {} })).rejects.toMatchObject({
      code: "ENC_NOT_ENCRYPTED",
    });
  });

  it("'passthrough': returns the raw value; next write re-encrypts", async () => {
    const space = encSpace("passthrough");
    const table = seedPlaintext(space);
    const row = (await table.findOne({ filter: { id: "legacy" }, controls: {} })) as any;
    expect(row.apiToken).toBe("plain-token");

    // Read-rewrite loop step: writing the value back encrypts it.
    await table.updateOne({ id: "legacy", apiToken: row.apiToken });
    const adapter = space.getAdapter(EncPartner) as MockAdapter;
    const call = adapter.calls.find((c) => c.method === "updateOne")!;
    expect(call.args[1].apiToken).toMatch(ENVELOPE_RE);
  });
});
