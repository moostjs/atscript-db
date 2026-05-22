@db.table "versioned_users"
export interface VersionedUser {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.column.version
    version: number
}

@db.table "versioned_orders"
export interface VersionedOrder {
    @meta.id
    @db.default.increment
    id: number

    status: string

    @db.column "v"
    @db.column.version
    revision: number
}

@db.table "plain_widgets"
export interface PlainWidget {
    @meta.id
    @db.default.increment
    id: number

    name: string
}
