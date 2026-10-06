// Fixture for aggregate-expr.spec.ts: query-time arithmetic and first / last
// over a small issue tracker. Mirrored in db-memory / db-mongo.

@db.table 'ae_issues'
export interface AeIssue {
    @meta.id
    id: number

    ticketId: number

    status: string

    price: number

    qty: number

    @db.column 'est_points'
    estimate?: number

    severity: number

    raisedAt?: number.timestamp

    title: string

    flag: boolean

    cost?: decimal
}

// first / last over a column type without MIN (uuid)
@db.table 'ae_refs'
export interface AeRef {
    @meta.id
    id: number

    grp: number

    @db.pg.type 'UUID'
    ref: string

    at: number
}

// first / last over native array columns (externally populated)
@db.table 'ae_arrays'
export interface AeArray {
    @meta.id
    id: number

    grp: number

    @db.pg.type 'TEXT[]'
    tags?: string

    @db.pg.type 'BOOLEAN[]'
    flags?: string

    at: number
}
