// Fixtures for error-codes.spec.ts (since 0.1.175): one table reaching every
// coded 400 / 409 of the HTTP gate and the write path.

@db.table 'ec_owners'
export interface EcOwner {
    @meta.id
    id: number

    name: string
}

@db.table 'ec_items'
@db.table.filterable 'manual'
export interface EcItem {
    @meta.id
    id: number

    @db.column.filterable
    title: string

    note?: string

    @db.column.version
    version: number

    @db.json
    tags?: string[]

    @db.writeOnly
    @db.column.filterable
    secret?: string

    contact?: {
        email: string
    }

    @db.rel.FK
    @db.column.filterable
    ownerId?: EcOwner.id

    @db.rel.to
    owner?: EcOwner
}
