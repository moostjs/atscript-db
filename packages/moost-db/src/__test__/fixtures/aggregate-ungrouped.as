// Ungrouped aggregates over HTTP (aggregate-ungrouped.spec.ts) — an aggregate
// `$select` without `$groupBy` is one row over the filtered set. Since 0.1.155.

@db.table 'ug_orders'
export interface UgOrder {
    @meta.id
    id: number

    status: string

    amount: number

    cost: number

    @db.writeOnly
    pin?: string
}

@db.view 'ug_open_orders'
@db.view.for UgOrder
@db.view.filter `UgOrder.status = 'open'`
export interface UgOpenOrder {
    id: UgOrder.id
    status: UgOrder.status
    amount: UgOrder.amount
}
