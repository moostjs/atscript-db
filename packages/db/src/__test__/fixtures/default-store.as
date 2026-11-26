// `@db.default.store` (since 0.1.196): the store fills the value when an insert leaves it out.
@db.table 'ds_orders'
@db.depth.limit 1
export interface DsOrder {
    @meta.id
    @db.default.store
    orderNo: string

    customer: string

    @db.default.store
    seq?: number

    @db.rel.from
    lines?: DsLine[]
}

@db.table 'ds_lines'
export interface DsLine {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    orderNo?: DsOrder.orderNo

    item: string
}
