// Fixture for aggregate-expr.spec.ts: query-time arithmetic and first / last
// over HTTP — numeric fields in every capability state (plain, optional,
// write-only, a decimal, a timestamp, text).

@db.table 'expr_tickets'
export interface ExprTicket {
    @meta.id
    @db.default.increment
    id: number

    ticketId: number

    status: string

    price: number

    qty: number

    estimate?: number

    raisedAt?: number.timestamp

    title: string

    cost: decimal

    @db.writeOnly
    secretRank?: number
}
