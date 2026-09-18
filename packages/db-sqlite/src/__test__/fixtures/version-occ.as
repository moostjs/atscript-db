@db.table 'versioned_users'
export interface VersionedUserTable {
    @meta.id
    id: number

    name: string

    status: string

    counter: number

    @db.column.version
    version: number.int
}

@db.table 'plain_widgets'
export interface PlainWidgetTable {
    @meta.id
    id: number

    name: string
}

@db.table 'versioned_lines'
export interface VersionedLineTable {
    @meta.id
    orderId: number

    @meta.id
    lineNo: number

    qty: number

    @db.column.version
    version: number.int
}
