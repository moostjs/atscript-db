// countDistinct over a field list, conditional aggregates ($where) and
// two-level aggregates ($from) over HTTP (aggregate-levels.spec.ts): every
// field a condition or an inner level reads passes the request gate. Since 0.1.168.

@db.table 'alh_sales'
export interface AlhSale {
    @meta.id
    id: number

    region: string

    customerId?: number

    status: string

    amount: number

    // hidden per request by the spec's `hasField` override
    cost: number

    @db.writeOnly
    margin?: number

    createdAt: number.timestamp
}

@db.table 'alh_tickets'
@db.table.filterable 'manual'
@db.table.sortable 'manual'
export interface AlhTicket {
    @meta.id
    id: number

    @db.column.filterable
    @db.column.sortable
    status: string

    priority: number

    region: string
}
