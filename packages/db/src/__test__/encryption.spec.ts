import { randomBytes } from "node:crypto";

import { describe, it, expect, vi } from "vite-plus/test";

import { DbEncryption } from "../encryption";
import { DbError } from "../db-error";

const KEY_1 = randomBytes(32);
const KEY_2 = randomBytes(32);

function service(overrides: Partial<ConstructorParameters<typeof DbEncryption>[0]> = {}) {
  return new DbEncryption({
    defaultKeyId: "k1",
    keys: { k1: KEY_1, k2: KEY_2 },
    ...overrides,
  });
}

const ENVELOPE_RE = /^aes1\$[\w.-]+\$[\w-]+\$[\w-]+\$[\w-]+$/;

describe("DbEncryption — envelope round-trips", () => {
  const enc = service();

  it.each([
    ["string", "hello world"],
    ["number", 42],
    ["boolean", true],
    ["nested object", { user: "u", pwd: "p", deep: { n: 1 } }],
    ["array", ["a", "b", 3]],
  ])("round-trips a %s value type-exactly", async (_label, value) => {
    const envelope = await enc.encrypt(value);
    expect(envelope).toMatch(ENVELOPE_RE);
    expect(await enc.decrypt(envelope)).toEqual(value);
  });

  it('keeps "42" (string) and 42 (number) distinguishable', async () => {
    expect(await enc.decrypt(await enc.encrypt("42"))).toBe("42");
    expect(await enc.decrypt(await enc.encrypt(42))).toBe(42);
  });

  it("produces a fresh IV per write (same plaintext → different envelopes)", async () => {
    const a = await enc.encrypt("same");
    const b = await enc.encrypt("same");
    expect(a).not.toBe(b);
    expect(a.split("$")[2]).not.toBe(b.split("$")[2]);
  });

  it("never embeds the plaintext in the envelope", async () => {
    const envelope = await enc.encrypt({ secret: "super-secret-password" });
    expect(envelope).not.toContain("super-secret-password");
  });

  it("detects envelopes via isEnvelope", async () => {
    expect(enc.isEnvelope(await enc.encrypt("x"))).toBe(true);
    expect(enc.isEnvelope("plaintext")).toBe(false);
    expect(enc.isEnvelope(42)).toBe(false);
    expect(enc.isEnvelope("aes1$incomplete")).toBe(false);
  });
});

describe("DbEncryption — tamper and key errors", () => {
  const enc = service();

  it("fails with ENC_DECRYPT_FAILED on a tampered auth tag", async () => {
    const parts = (await enc.encrypt("value")).split("$");
    parts[3] = Buffer.from(randomBytes(16)).toString("base64url");
    await expect(enc.decrypt(parts.join("$"))).rejects.toMatchObject({
      code: "ENC_DECRYPT_FAILED",
    });
  });

  it("fails with ENC_DECRYPT_FAILED on tampered ciphertext", async () => {
    const parts = (await enc.encrypt("value")).split("$");
    parts[4] = Buffer.from(randomBytes(24)).toString("base64url");
    await expect(enc.decrypt(parts.join("$"))).rejects.toMatchObject({
      code: "ENC_DECRYPT_FAILED",
    });
  });

  it("names the keyId when it is unknown (never the key material)", async () => {
    const foreign = new DbEncryption({ defaultKeyId: "kX", keys: { kX: randomBytes(32) } });
    const envelope = await foreign.encrypt("v");
    const error = await enc.decrypt(envelope).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe("ENC_DECRYPT_FAILED");
    expect((error as DbError).message).toContain("kX");
  });

  it("rejects malformed envelopes", async () => {
    await expect(enc.decrypt("aes9$k1$a$b$c")).rejects.toMatchObject({
      code: "ENC_DECRYPT_FAILED",
    });
  });
});

describe("DbEncryption — key normalization (config-time)", () => {
  it("accepts a 32-byte Buffer, 64-char hex, base64, and 32-char utf8", () => {
    expect(
      () =>
        new DbEncryption({
          defaultKeyId: "buf",
          keys: {
            buf: randomBytes(32),
            hex: randomBytes(32).toString("hex"),
            b64: randomBytes(32).toString("base64"),
            utf8: "a".repeat(32),
          },
        }),
    ).not.toThrow();
  });

  it("throws ENC_KEY_INVALID for wrong-size key material at config time", () => {
    expect(() => new DbEncryption({ defaultKeyId: "k", keys: { k: randomBytes(16) } })).toThrow(
      expect.objectContaining({ code: "ENC_KEY_INVALID" }),
    );
    expect(() => new DbEncryption({ defaultKeyId: "k", keys: { k: "too-short" } })).toThrow(
      expect.objectContaining({ code: "ENC_KEY_INVALID" }),
    );
  });

  it("throws ENC_KEY_INVALID when defaultKeyId has no key and no resolver", () => {
    expect(() => new DbEncryption({ defaultKeyId: "missing", keys: { k1: KEY_1 } })).toThrow(
      expect.objectContaining({ code: "ENC_KEY_INVALID" }),
    );
  });

  it("rejects key ids containing '$' (envelope delimiter)", () => {
    expect(
      () => new DbEncryption({ defaultKeyId: "ok", keys: { ok: KEY_1, ba$d: KEY_2 } }),
    ).toThrow(expect.objectContaining({ code: "ENC_KEY_INVALID" }));
  });
});

describe("DbEncryption — resolveKey", () => {
  it("resolves async keys and caches per keyId", async () => {
    const resolveKey = vi.fn(async () => KEY_1);
    const enc = new DbEncryption({ defaultKeyId: "kms1", resolveKey });
    const envelope = await enc.encrypt("v");
    expect(await enc.decrypt(envelope)).toBe("v");
    await enc.encrypt("w");
    expect(resolveKey).toHaveBeenCalledTimes(1);
    expect(resolveKey).toHaveBeenCalledWith("kms1");
  });

  it("surfaces resolver failures as decrypt errors carrying the keyId", async () => {
    const good = service();
    const envelope = await good.encrypt("v");
    const enc = new DbEncryption({
      defaultKeyId: "other",
      keys: { other: KEY_2 },
      resolveKey: () => {
        throw new Error("KMS down");
      },
    });
    const error = await enc.decrypt(envelope).catch((e: unknown) => e);
    expect((error as DbError).code).toBe("ENC_DECRYPT_FAILED");
    expect((error as DbError).message).toContain("k1");
  });
});

describe("DbEncryption — key rotation", () => {
  it("decrypts old-key envelopes and re-encrypts under the new default", async () => {
    const v1 = new DbEncryption({ defaultKeyId: "k1", keys: { k1: KEY_1 } });
    const oldEnvelope = await v1.encrypt({ token: "t" });
    expect(oldEnvelope.split("$")[1]).toBe("k1");

    // Rotate: default flips to k2, k1 stays in the registry for old rows.
    const v2 = new DbEncryption({ defaultKeyId: "k2", keys: { k1: KEY_1, k2: KEY_2 } });
    const plain = await v2.decrypt(oldEnvelope);
    expect(plain).toEqual({ token: "t" });
    const newEnvelope = await v2.encrypt(plain);
    expect(newEnvelope.split("$")[1]).toBe("k2");

    // Dropping k1 makes old envelopes fail cleanly.
    const v3 = new DbEncryption({ defaultKeyId: "k2", keys: { k2: KEY_2 } });
    await expect(v3.decrypt(oldEnvelope)).rejects.toMatchObject({ code: "ENC_DECRYPT_FAILED" });
    expect(await v3.decrypt(newEnvelope)).toEqual({ token: "t" });
  });
});
