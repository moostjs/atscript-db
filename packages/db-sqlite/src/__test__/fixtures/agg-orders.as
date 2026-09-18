@db.table "orders"
export interface AggOrders {
    @meta.id
    @db.default.increment
    id: number

    @db.column.dimension
    status: string

    @db.column.dimension
    currency: string

    @db.column.measure
    amount: number

    @db.column.measure
    quantity: number
}

// Aggregate row shape (aggregate.spec.ts): a flattened nested object —
// `stats.views` is the `stats__views` column; grouped, it must come back
// nested (`{ stats: { views } }`) like regular rows do. Loose mode (no
// dimension / measure annotations) so any column groups.
@db.table "agg_pages"
export interface AggPages {
    @meta.id
    @db.default.increment
    id: number

    title: string

    stats: {
        views: number
    }

    // Grouped booleans come back `true` / `false` (SQLite stores 0 / 1)
    published?: boolean
}
