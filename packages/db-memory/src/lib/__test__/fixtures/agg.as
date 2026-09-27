// Fixture for aggregate.spec.ts — grouping dimensions (flat, optional and
// nested), numeric measures and `number.timestamp` bucket sources.

@db.table 'agg_events'
export interface AggEvent {
    @meta.id
    id: number

    region: string

    status?: string

    amount?: number

    openedAt: number.timestamp

    closedAt?: number.timestamp

    stats: {
        source?: string
        views: number
    }
}

// A measure renamed with @db.column — the default aggregate alias must stay
// logical (`sum_amount`, not `sum_amount_cents`).
@db.table 'agg_payments'
export interface AggPayment {
    @meta.id
    id: number

    region: string

    @db.column 'amount_cents'
    amount?: number
}
