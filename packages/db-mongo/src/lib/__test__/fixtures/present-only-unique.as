@db.table 'creds'
@db.mongo.collection
export interface Creds {
    // Required unique field → plain unique index (no nulls possible).
    @db.index.unique 'username_idx'
    username: string

    // Optional unique string → present-only (partial) unique index.
    @db.index.unique 'email_idx'
    email?: string.email

    // Optional unique NON-string → $type must be derived from the design type,
    // not hardcoded to 'string' (regression guard for the number case).
    @db.index.unique 'extid_idx'
    externalId?: number

    // Composite unique over a required + an optional field. The partial filter
    // must cover only the optional field, matching SQL NULLS DISTINCT.
    @db.index.unique 'tenant_handle_idx'
    tenantId: string

    @db.index.unique 'tenant_handle_idx'
    handle?: string

    // Optional unique mongo.objectId → must match BOTH 'objectId' and 'string',
    // since the value may be persisted either way.
    @db.index.unique 'extref_idx'
    externalRef?: mongo.objectId

    // Composite unique over TWO optional fields → partial filter must $and both,
    // with clauses sorted by field name for a stable round-trip.
    @db.index.unique 'pair_idx'
    zeta?: string

    @db.index.unique 'pair_idx'
    alpha?: string
}
