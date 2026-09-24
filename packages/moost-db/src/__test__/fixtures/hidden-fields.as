// Fixture for hidden-fields.spec.ts — a table whose controller hides some
// fields per request through `hasField`: a plain column, a searchable one, a
// timestamp, a write-only one, a flattened object and a navigation relation.

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
