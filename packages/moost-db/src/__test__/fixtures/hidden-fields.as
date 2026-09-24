// Fixture for hidden-fields.spec.ts — a table whose controller hides some
// fields per request through `hasField`: a plain column, a searchable one, a
// timestamp, a write-only one, a flattened object and a navigation relation.
// HiddenCode / HiddenSlug carry unique indexes over hidden fields (identity
// resolution must ignore them) and an object with one hidden leaf.

@db.table 'hidden_owners'
export interface HiddenOwner {
    @meta.id
    id: number

    name: string
}

@db.table 'hidden_accounts'
export interface HiddenAccount {
    @meta.id
    id: number

    @db.column.searchable
    name: string

    @db.column.searchable
    password: string

    points: number

    lockedAt?: number.timestamp

    @db.writeOnly
    pin?: string

    profile: {
        bio: string
    }

    @db.rel.FK
    ownerId: HiddenOwner.id

    @db.rel.to
    owner?: HiddenOwner
}

@db.table 'hidden_codes'
export interface HiddenCode {
    @meta.id
    id: number

    @db.index.unique 'code_idx'
    code: string

    @db.index.unique 'pair_idx'
    tenant: string

    @db.index.unique 'pair_idx'
    secret: string

    @db.index.unique 'serial_idx'
    serial: string

    title: string

    contact: {
        email: string
        phone: string
    }
}

@db.table 'hidden_slugs'
@db.table.preferredId.uniqueIndex 'slug_idx'
export interface HiddenSlug {
    @meta.id
    id: number

    @db.index.unique 'slug_idx'
    slug: string

    title: string
}
