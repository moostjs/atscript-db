// `@normalize.*` over HTTP (normalize-writes.spec.ts). Since 0.1.170.

@db.table 'nwh_accounts'
export interface NwhAccount {
    @meta.id
    id: number

    @db.index.unique 'nwh_email_idx'
    @normalize.trim
    @normalize.lowercase
    email: string

    @normalize.trim
    name: string

    @db.column.version
    version: number.int
}
