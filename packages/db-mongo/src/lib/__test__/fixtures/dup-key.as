// Unique indexes hit by every write path (duplicate-key-server.spec.ts).

@db.table 'dk_users'
export interface DkUser {
    @meta.id
    id: number

    @db.index.unique 'dk_email'
    email: string

    @db.index.unique 'dk_handle'
    handle?: string

    @db.json
    payload?: {
        ref?: string
    }

    @db.column.derived
    @db.index.unique 'dk_ref'
    ref?: DkUser.payload.ref
}
