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
