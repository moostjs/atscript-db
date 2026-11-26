// `@db.column.version.token` (since 0.1.196): a version the store issues.
@db.table 'vt_tickets'
export interface VtTicket {
    @meta.id
    id: number

    title: string

    @db.column.version
    @db.column.version.token
    etag: string
}

@db.table 'vt_counters'
export interface VtCounter {
    @meta.id
    id: number

    title: string

    @db.column.version
    version: number.int
}
