# encryption (@db.encrypted — field-level encryption at rest)

Declarative at-rest encryption: the core layer AES-256-GCM-encrypts annotated fields before the adapter sees them and decrypts on read. Ciphertext is a plain string → **identical behavior on all four adapters**, zero engine setup.

**TL;DR.** Annotate the field with `@db.encrypted`, pass `encryption: { defaultKeyId, keys }` in the `DbSpace` options bag. Reads/writes are transparent. Filtering/sorting/indexing/arithmetic-patching the field throws (`ENC_FIELD_*`). HTTP returns **decrypted** values — encryption is at-rest protection, not authorization.

## Quick start

```atscript
@db.table 'partners'
export interface Partner {
    @meta.id
    id: string
    legalName: string
    @db.encrypted
    apiToken?: string
    @db.encrypted
    creditCredentials?: { user: string, pwd: string }   // any JSON-serializable type
}
```

```ts
const db = new DbSpace(() => new SqliteAdapter(driver), {
  encryption: {
    defaultKeyId: "k2",
    keys: { k1: process.env.DB_ENC_KEY_1!, k2: process.env.DB_ENC_KEY_2! }, // 32-byte each
  },
});
const partners = db.getTable(Partner);
await partners.insertOne({ id, legalName, creditCredentials: { user: "u", pwd: "p" } });
// stored: creditCredentials = "aes1$k2$<iv>$<tag>$<ct>"
const p = await partners.findOne({ filter: { id }, controls: {} });
p.creditCredentials; // { user: "u", pwd: "p" } — decrypted transparently
```

Key formats accepted: 32-byte `Buffer`, 64-char hex, base64, or raw 32-char string. KMS/Vault: use `resolveKey: async (keyId) => Buffer` instead of (or alongside) `keys` — called once per keyId, cached for the process lifetime.

## Invariants

| #   | Rule                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Model declares `@db.encrypted` but `DbSpace` has no `encryption` config → `DbError("ENC_CONFIG_MISSING")` at first table use / sync. Plaintext is never silently stored.                                                                                                                                       |
| 2   | Bad key material (wrong size, `$` in keyId, defaultKeyId unresolvable) → `ENC_KEY_INVALID` at `DbSpace` **construction**, not first write.                                                                                                                                                                     |
| 3   | Filter on an encrypted field (incl. nested paths like `cred.user`, inside `$or`/`$not`) → `ENC_FIELD_FILTER`. `$sort` → `ENC_FIELD_SORT`. `$groupBy`/aggregates → `ENC_FIELD_AGG`. All → HTTP 400.                                                                                                             |
| 4   | `$inc`/`$dec`/`$mul`/array patch ops on an encrypted field → `ENC_FIELD_PATCH_OP`. Plain assignment is fine — it re-encrypts.                                                                                                                                                                                  |
| 5   | Compile/build-time rejected combos: `@meta.id`, `@db.rel.FK` (or being an FK target), any `@db.index.*` (incl. geo), `@db.search.*`, `@db.mongo.search.*`, `@db.column.version`, `@db.default.increment`/`.now`, `@db.patch.strategy "merge"`. Plain `@db.default 'literal'` is allowed (applied pre-encrypt). |
| 6   | An encrypted nested object stores as **one opaque text column** — no flattened child columns (SQL), no nested doc (Mongo). Column type: `TEXT` (SQL) / string (Mongo).                                                                                                                                         |
| 7   | **HTTP returns decrypted values.** Encryption ≠ redaction — gate read access with projections/permissions as usual. `/meta` reports `encrypted: true`, `filterable: false`, `sortable: false`.                                                                                                                 |
| 8   | Rotation = flip `defaultKeyId`, keep old keys in the registry. Envelopes record their keyId; rows re-encrypt on next write. Dropping a key with live envelopes → `ENC_DECRYPT_FAILED` on those rows.                                                                                                           |
| 9   | Adding `@db.encrypted` to a populated column does NOT encrypt existing rows. Migration: deploy `onUnencrypted: 'passthrough'` → read-rewrite loop → revert to `'error'` (default).                                                                                                                             |
| 10  | Tampered/corrupt envelope or unknown keyId → `ENC_DECRYPT_FAILED` (carries table/field/keyId, never plaintext). JSON-serialized plaintext → round-trips are type-exact (`"42"` ≠ `42`).                                                                                                                        |
| 11  | Toggling `@db.encrypted` changes the schema hash → sync runs (SQL column-type migration; Mongo metadata-only). Key material is never persisted or hashed.                                                                                                                                                      |
| 12  | Keys live app-side by design (threat model: DB dumps/backups/operators — NOT an attacker controlling the app). No-key-in-process needs → MongoDB CSFLE independently (own `MongoClient` `autoEncryption`); don't combine with `@db.encrypted` on the same field.                                               |

## Key imports

```ts
import { DbSpace, DbError, DbEncryption } from "@atscript/db"; // DbEncryption: standalone envelope service (rarely needed directly)
import type { TDbEncryptionOptions, TDbSpaceOptions } from "@atscript/db";
```

## References

| Domain          | File                               | When                                              |
| --------------- | ---------------------------------- | ------------------------------------------------- |
| Annotations     | [annotations.md](./annotations.md) | Other `@db.*` annotations on the same model       |
| Patch semantics | [patch.md](./patch.md)             | Why `$inc`/array ops are rejected; allowed shapes |
| Schema sync     | [schema-sync.md](./schema-sync.md) | Hash drift, migration mechanics                   |
| Geo             | [geo-search.md](./geo-search.md)   | `@db.index.geo` (mutually exclusive)              |

## See also

- Docs: https://db.atscript.dev/api/encryption
