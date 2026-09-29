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

@db.table 'versioned_renamed'
export interface VersionedRenamedTable {
    @meta.id
    id: number

    name: string

    note?: string

    @db.column 'row_version'
    @db.column.version
    version: number.int
}
