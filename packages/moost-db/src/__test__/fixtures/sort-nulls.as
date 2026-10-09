// NULL placement in sorts (since 0.1.153): URL suffix `$sort=-amount:last`,
// `@db.sort.nulls` defaults, the sortable gate and `/meta`.

@db.table 'sn_http_rows'
@db.table.sortable 'manual'
export interface SnHttpRow {
    @meta.id
    @db.column.sortable
    id: number

    @db.column.sortable
    amount?: number

    @db.column.sortable
    @db.sort.nulls 'last'
    closedAt?: number

    // not sortable (manual policy)
    note?: string
}
