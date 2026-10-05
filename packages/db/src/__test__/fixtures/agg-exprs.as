// Fixture for aggregate-expr.spec.ts: query-time arithmetic and first / last —
// numeric operands, every non-numeric kind (string, boolean, decimal,
// timestamp, JSON leaf, encrypted), a `@db.column` rename, a quantity ref and
// a strict (dimension / measure) twin.

@db.table 'expr_issues'
export interface ExprIssue {
    @meta.id
    @db.default.increment
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

    cost: decimal

    @db.json
    meta: {
        weight: number
    }

    @db.encrypted
    secretScore?: number

    @db.unit.ref 'unit'
    weight: number

    unit: string
}

@db.table 'expr_strict'
export interface ExprStrict {
    @meta.id
    @db.default.increment
    id: number

    @db.column.dimension
    status: string

    @db.column.measure
    price: number

    @db.column.measure
    qty: number

    note: number
}
