---
outline: deep
---

# Field Encryption

<!--@include: ../_experimental-warning.md-->

`@db.encrypted` encrypts a field **at rest**: the core layer AES-256-GCM-encrypts the value before it reaches the adapter and decrypts it on read — completely transparent to application code. Ciphertext is stored as a plain string, so the feature works identically on **all four adapters** with no engine-specific setup.

Typical use: credential blocks on operational documents — API tokens, feed auth headers, provider passwords — where the invariant "never store this in cleartext" belongs in the model, not in a hand-rolled service layer.

## Declaring Encrypted Fields

```atscript
@db.table 'partners'
export interface Partner {
    @meta.id
    id: string

    legalName: string

    @db.encrypted
    apiToken?: string

    @db.encrypted
    creditCredentials?: {
        user: string
        pwd: string
    }
}
```

Any JSON-serializable type works — string, number, boolean, nested object, array. The declared type keeps governing validation and TypeScript typing; only the storage representation changes. An encrypted nested object is stored as **one opaque text column** (no flattening into child columns).

## Configuring Keys

Pass an `encryption` block in the `DbSpace` options bag. Without it, any model declaring `@db.encrypted` fails fast with `ENC_CONFIG_MISSING` — plaintext is never silently stored.

```typescript
import { DbSpace } from "@atscript/db";

const db = new DbSpace(() => new MongoAdapter(mongo, client), {
  encryption: {
    defaultKeyId: "k2",
    keys: {
      k1: process.env.DB_ENC_KEY_1!, // old key — kept for existing rows
      k2: process.env.DB_ENC_KEY_2!, // used for all new writes
    },
  },
});
```

| Option          | Description                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `defaultKeyId`  | Key used for all new writes                                                                                     |
| `keys`          | Key registry: keyId → 32-byte key (`Buffer`, 64-char hex, base64, or 32-char string)                            |
| `resolveKey`    | Async resolver (KMS, Vault, env indirection) — called once per keyId, cached for the process lifetime           |
| `onUnencrypted` | `'error'` (default) or `'passthrough'` — what to do when a stored value is not an encryption envelope (§ below) |

Key material is validated eagerly at `DbSpace` construction — a wrong-size key throws `ENC_KEY_INVALID` immediately, not at first write.

### AWS KMS / Vault

Use `resolveKey` with the envelope-encryption pattern — keep a KMS-encrypted 32-byte data key in config and decrypt it once at boot:

```typescript
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";

const kms = new KMSClient({});
const db = new DbSpace(adapterFactory, {
  encryption: {
    defaultKeyId: "k1",
    resolveKey: async (keyId) => {
      const { Plaintext } = await kms.send(
        new DecryptCommand({
          CiphertextBlob: Buffer.from(process.env[`DB_ENC_KEY_${keyId}`]!, "base64"),
        }),
      );
      return Buffer.from(Plaintext!); // must be 32 bytes
    },
  },
});
```

Note the threat-model boundary: keys live **app-side by design**. The key must exist in process memory; this protects against database dumps, backups, and DB operators — not against an attacker who controls the application process. If you need a no-key-in-process guarantee on MongoDB, use driver-level CSFLE/Queryable Encryption independently (construct the `MongoClient` with `autoEncryption` and don't combine it with `@db.encrypted` on the same fields).

## How Values Are Stored

Stored values are single ASCII envelope strings:

```
aes1$<keyId>$<iv>$<tag>$<ciphertext>
```

- Fresh random IV per write — two writes of the same plaintext produce different ciphertexts.
- The plaintext is JSON-serialized before encryption, so round-trips are type-exact (`"42"` and `42` stay distinguishable).
- Column types: `TEXT` on SQLite/PostgreSQL/MySQL, plain string on MongoDB. Declared-type column sizing does not apply — ciphertext length depends on the plaintext.

Reads, list queries, search results, and relation loads all decrypt transparently. A tampered or corrupted value fails with `ENC_DECRYPT_FAILED` (carrying table/field/keyId — never partial plaintext); an envelope referencing a key missing from the registry fails the same way, naming the keyId.

## What's Not Allowed

Ciphertext is opaque, so anything that needs to _interpret_ the stored value is rejected loudly:

**At compile/build time** — `@db.encrypted` cannot combine with: `@meta.id`, `@db.rel.FK` (or being an FK target), any `@db.index.*` (incl. [geo](/search/geo-search)), `@db.search.vector`/`@db.search.filter`, `@db.mongo.search.*`, [`@db.column.version`](/api/versioning), `@db.default.increment`/`@db.default.now`, or `@db.patch.strategy "merge"`. (A plain `@db.default 'literal'` is fine — it's applied app-side before encryption.)

**At query/patch time** — engine-agnostic `DbError` rejections before any SQL/pipeline is built:

| Attempt                                                                       | Error                |
| ----------------------------------------------------------------------------- | -------------------- |
| Filtering on an encrypted field (incl. nested paths into an encrypted object) | `ENC_FIELD_FILTER`   |
| `$sort` on an encrypted field                                                 | `ENC_FIELD_SORT`     |
| `$groupBy` / aggregate references                                             | `ENC_FIELD_AGG`      |
| Arithmetic/array patch ops (`$inc`, `$insert`, …)                             | `ENC_FIELD_PATCH_OP` |

Plain assignment in updates is allowed — the new value is simply re-encrypted. Over HTTP all of these surface as `400`.

`/meta` reports `encrypted: true` on the field with `filterable: false` and `sortable: false` (the adapter veto wins over any `@db.column.filterable` annotation).

::: warning HTTP responses return decrypted values
Encryption is **at-rest** protection, not transport-level redaction. Read endpoints return plaintext to authorized callers. Who may see the field over HTTP remains an authorization concern — use projections, `transformProjection()`, or permission guards exactly as you would for any sensitive field.
:::

## Key Rotation

Rotation is a config change: flip `defaultKeyId` to the new key and **keep old keys in the registry**. Each envelope records the keyId it was encrypted with, so old rows keep decrypting; they re-encrypt under the new key on their next natural write. To rotate eagerly, run a read-and-rewrite loop over affected rows. Drop an old key only after no envelopes reference it — afterwards those rows fail with `ENC_DECRYPT_FAILED`.

## Migrating Existing Plaintext Columns

Adding `@db.encrypted` to a live, populated column does **not** encrypt existing rows (schema sync never rewrites data). Until they're migrated, reads of plaintext rows fail with `ENC_NOT_ENCRYPTED` under the default policy. The migration recipe:

1. Deploy with `onUnencrypted: 'passthrough'` — plaintext rows are returned as-is; anything written goes out encrypted.
2. Run a read-and-rewrite loop over the table (each write re-encrypts).
3. Switch back to `onUnencrypted: 'error'` (the default) so stray plaintext fails loudly again.

Schema-sync notes: toggling `@db.encrypted` changes the field's storage type and the schema hash → sync runs (a column-type migration on SQL, metadata-only on MongoDB). Key material is **never** persisted, hashed into the snapshot, or otherwise written to the database. See [What Gets Synced](/sync/what-gets-synced).

## DOs and DON'Ts

- **DO** keep every key that still has live envelopes in the registry — removing a key bricks its rows.
- **DO** treat HTTP exposure separately — encrypted ≠ hidden; wire projections/permissions for read access.
- **DON'T** filter, sort, group, or index on encrypted fields — design lookups around other fields (or wait for the planned blind-index support).
- **DON'T** put `@meta.id`, FKs, or version columns under encryption — addressing and OCC need cleartext equality.
- **DON'T** combine with MongoDB CSFLE on the same field — you'd double-encrypt.

## Next Steps

- [Storage & Nested Objects](/api/storage) — the storage modes encrypted fields bypass
- [Geo Search](/search/geo-search) — mutually exclusive with `@db.encrypted`
- [What Gets Synced](/sync/what-gets-synced) — schema-sync behavior on annotation toggles
