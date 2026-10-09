// NULL placement in sort (since 0.1.153): `$nulls` / `@db.sort.nulls` on a
// read's `$sort`, a grouped `$sort` and the `first()` / `last()` row order.
// `@db.column`-renamed sort columns check the physical-name translation.

@db.table 'sn_owners'
export interface SnOwner {
    @meta.id
    id: number

    label: string

    @db.rel.from
    items?: SnItem[]
}

@db.table 'sn_items'
export interface SnItem {
    @meta.id
    id: number

    @db.index.fulltext 'sn_name_ft'
    name: string

    category?: string

    @db.index.plain 'sn_amt'
    @db.column 'amt'
    amount?: number

    @db.sort.nulls 'last'
    @db.column 'closed_at'
    closedAt?: number.timestamp

    @db.rel.FK
    @db.column 'owner_ref'
    ownerId?: SnOwner.id

    @db.rel.to
    owner?: SnOwner
}
