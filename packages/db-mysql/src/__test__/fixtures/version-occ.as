@db.table 'versioned_items'
export interface VersionedItemTable {
    @meta.id
    id: number

    name: string

    note?: string

    @db.default '10000'
    cap: number

    @db.column.version
    version: number.int
}
