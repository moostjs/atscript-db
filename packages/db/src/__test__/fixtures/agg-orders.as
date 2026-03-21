@db.table "orders"
export interface AggOrders {
    @meta.id
    @db.default.increment
    id: number

    @db.column.dimension
    status: string

    @db.column.dimension
    @db.column "region_code"
    region: string

    @db.column.measure
    amount: number

    @db.column.measure
    quantity: number

    name: string
}

@db.table "plain_events"
export interface PlainEvents {
    @meta.id
    @db.default.increment
    id: number

    category: string
    value: number
    label: string
}

@db.table "indexed_metrics"
export interface IndexedMetrics {
    @meta.id
    @db.default.increment
    id: number

    @db.column.dimension
    @db.index.plain
    channel: string

    @db.column.dimension
    source: string

    @db.column.dimension
    @db.index.unique
    code: string

    @db.column.measure
    revenue: number
}
