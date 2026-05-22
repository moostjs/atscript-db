@db.table 'versioned_users'
export interface VersionedUserTable {
    @meta.id
    id: number

    name: string

    status: string

    counter: number

    @db.column.version
    version: number
}

@db.table 'plain_widgets'
export interface PlainWidgetTable {
    @meta.id
    id: number

    name: string
}
