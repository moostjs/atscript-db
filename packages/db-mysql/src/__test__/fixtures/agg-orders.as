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
