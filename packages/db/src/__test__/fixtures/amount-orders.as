@db.table "multi_currency_orders"
export interface MultiCurrencyOrder {
    @meta.id
    @db.default.increment
    id: number

    @db.column.dimension
    status: string

    @db.column.dimension
    currency: db.currencyCode

    @db.column.measure
    @db.amount.currency.ref 'currency'
    amount: decimal

    name: string
}

@db.table "single_currency_orders"
export interface SingleCurrencyOrder {
    @meta.id
    @db.default.increment
    id: number

    @db.column.dimension
    status: string

    @db.column.measure
    @db.amount.currency 'EUR'
    amount: decimal
}
