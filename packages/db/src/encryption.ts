import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { DbError } from "./db-error";

/**
 * Configuration for field-level encryption at rest (`@db.encrypted`).
 * Passed to `DbSpace` via the options bag.
 */
export interface TDbEncryptionOptions {
  /** Key used for all new writes. */
  defaultKeyId: string;
  /**
   * Key registry: keyId → 32-byte key (Buffer, or base64/hex/utf8 string).
   * Decryption looks keys up by the keyId recorded in each value's envelope,
   * so old keys stay in the registry for as long as data encrypted with them exists.
   */
  keys?: Record<string, string | Buffer>;
  /**
   * Alternative/supplement to `keys`: async resolver (KMS, Vault, env indirection).
   * Called once per keyId, result cached for the process lifetime.
   */
  resolveKey?: (keyId: string) => Promise<string | Buffer> | string | Buffer;
  /**
   * What to do when a stored value is NOT a valid envelope (pre-existing
   * plaintext rows, e.g. when @db.encrypted is added to a live column).
   *  - 'error' (default): fail the read with DbError("ENC_NOT_ENCRYPTED")
   *  - 'passthrough': return the raw value as-is (migration window mode);
   *    the value gets encrypted on its next write.
   */
  onUnencrypted?: "error" | "passthrough";
}

const ENVELOPE_VERSION = "aes1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

/** `aes1$<keyId>$<iv>$<tag>$<ciphertext>` — every segment base64url, keyId [A-Za-z0-9_.-]. */
const ENVELOPE_RE = /^aes1\$[\w.-]+\$[\w-]+\$[\w-]+\$[\w-]+$/;
const KEY_ID_RE = /^[\w.-]+$/;

/**
 * Normalizes key material to a 32-byte Buffer.
 * Accepts: a 32-byte Buffer, a 64-char hex string, a base64/base64url string
 * decoding to 32 bytes, or a raw utf8 string of exactly 32 bytes.
 */
function normalizeKey(keyId: string, material: string | Buffer): Buffer {
  if (Buffer.isBuffer(material)) {
    if (material.length === KEY_BYTES) {
      return material;
    }
    throw keyInvalid(keyId, `expected ${KEY_BYTES} bytes, got ${material.length}`);
  }
  if (typeof material === "string") {
    if (/^[0-9a-f]{64}$/i.test(material)) {
      return Buffer.from(material, "hex");
    }
    if (/^[\w+/-]+={0,2}$/.test(material)) {
      const decoded = Buffer.from(material, "base64");
      if (decoded.length === KEY_BYTES) {
        return decoded;
      }
    }
    const utf8 = Buffer.from(material, "utf8");
    if (utf8.length === KEY_BYTES) {
      return utf8;
    }
    throw keyInvalid(keyId, `cannot derive a ${KEY_BYTES}-byte key from the provided string`);
  }
  throw keyInvalid(keyId, "key material must be a string or Buffer");
}

function keyInvalid(keyId: string, reason: string): DbError {
  return new DbError("ENC_KEY_INVALID", [
    { path: `encryption.keys.${keyId}`, message: `Invalid encryption key "${keyId}": ${reason}` },
  ]);
}

/** Decryption context — carried into error messages (never the key itself). */
export interface TDecryptContext {
  table?: string;
  field?: string;
}

/**
 * AES-256-GCM envelope encryption service for `@db.encrypted` fields.
 *
 * Owned by `DbSpace` and shared across all tables in the space. Values are
 * `JSON.stringify`'d before encryption (type-exact round-trips) and stored as
 * a single ASCII envelope string: `aes1$<keyId>$<iv>$<tag>$<ciphertext>`.
 *
 * Key material is validated eagerly at construction (`ENC_KEY_INVALID`);
 * `resolveKey` lookups are cached per keyId for the process lifetime.
 */
export class DbEncryption {
  readonly defaultKeyId: string;
  readonly onUnencrypted: "error" | "passthrough";

  private readonly _keys = new Map<string, Buffer>();
  private readonly _resolveKey?: TDbEncryptionOptions["resolveKey"];
  private readonly _resolved = new Map<string, Promise<Buffer>>();

  constructor(options: TDbEncryptionOptions) {
    if (!options.defaultKeyId || !KEY_ID_RE.test(options.defaultKeyId)) {
      throw new DbError("ENC_KEY_INVALID", [
        {
          path: "encryption.defaultKeyId",
          message: `Invalid defaultKeyId "${options.defaultKeyId}" — expected a non-empty id matching [A-Za-z0-9_.-]+`,
        },
      ]);
    }
    this.defaultKeyId = options.defaultKeyId;
    this.onUnencrypted = options.onUnencrypted ?? "error";
    this._resolveKey = options.resolveKey;

    if (options.keys) {
      for (const [keyId, material] of Object.entries(options.keys)) {
        if (!KEY_ID_RE.test(keyId)) {
          throw keyInvalid(keyId, "key ids must match [A-Za-z0-9_.-]+ (no '$')");
        }
        this._keys.set(keyId, normalizeKey(keyId, material));
      }
    }

    if (!this._keys.has(this.defaultKeyId) && !this._resolveKey) {
      throw new DbError("ENC_KEY_INVALID", [
        {
          path: "encryption.defaultKeyId",
          message: `defaultKeyId "${this.defaultKeyId}" is not in the key registry and no resolveKey() was provided`,
        },
      ]);
    }
  }

  /** True when `value` looks like an encryption envelope produced by this service. */
  isEnvelope(value: unknown): value is string {
    return typeof value === "string" && ENVELOPE_RE.test(value);
  }

  /** Encrypts a JSON-serializable value into an envelope string using the default key. */
  async encrypt(value: unknown): Promise<string> {
    const keyId = this.defaultKeyId;
    const key = await this._getKey(keyId);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      ENVELOPE_VERSION,
      keyId,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join("$");
  }

  /** Decrypts an envelope string back into its plaintext value. */
  async decrypt(envelope: string, ctx?: TDecryptContext): Promise<unknown> {
    const parts = envelope.split("$");
    if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
      throw this._decryptFailed(ctx, "unknown", "malformed envelope");
    }
    const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string];
    let key: Buffer;
    try {
      key = await this._getKey(keyId);
    } catch {
      throw this._decryptFailed(ctx, keyId, `unknown encryption key "${keyId}"`);
    }
    try {
      const iv = Buffer.from(ivB64, "base64url");
      const tag = Buffer.from(tagB64, "base64url");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new Error("bad iv/tag length");
      }
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ctB64, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plaintext);
    } catch {
      throw this._decryptFailed(ctx, keyId, "authentication failed or corrupted ciphertext");
    }
  }

  private _decryptFailed(ctx: TDecryptContext | undefined, keyId: string, reason: string): DbError {
    const where = ctx?.table || ctx?.field ? ` on ${ctx?.table ?? "?"}.${ctx?.field ?? "?"}` : "";
    return new DbError("ENC_DECRYPT_FAILED", [
      {
        path: ctx?.field ?? "",
        message: `Decryption failed${where} (keyId: ${keyId}): ${reason}`,
      },
    ]);
  }

  private _getKey(keyId: string): Promise<Buffer> {
    const known = this._keys.get(keyId);
    if (known) {
      return Promise.resolve(known);
    }
    let pending = this._resolved.get(keyId);
    if (!pending) {
      const resolver = this._resolveKey;
      if (!resolver) {
        return Promise.reject(keyInvalid(keyId, "not in the key registry"));
      }
      pending = Promise.resolve()
        .then(() => resolver(keyId))
        .then((material) => normalizeKey(keyId, material));
      // Drop failed resolutions so a transient KMS error doesn't poison the cache.
      pending.catch(() => this._resolved.delete(keyId));
      this._resolved.set(keyId, pending);
    }
    return pending;
  }
}
