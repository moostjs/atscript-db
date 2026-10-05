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
