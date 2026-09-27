// countDistinct + conditional view aggregates (aggregate-distinct.spec.ts),
// mirrored by db-mongo's agg-count-distinct-server.spec.ts. Since 0.1.136.

@db.table 'ad_customers'
export interface AdCustomer {
    @meta.id
    id: number

    name: string

    vip: boolean
}

@db.table 'ad_orders'
export interface AdOrder {
    @meta.id
    id: number

    city: string

    customerId?: number

    status: string

    @db.column 'amount_cents'
    amount?: number
}

@db.view 'ad_city_stats'
@db.view.for AdOrder
@db.view.joins AdCustomer, `AdCustomer.id = AdOrder.customerId`, 'left'
export interface AdCityStats {
    city: AdOrder.city

    @db.agg.count
    orders: number

    @db.agg.count '*', `status = 'paid'`
    paidOrders: number

    @db.agg.count "amount", `status = 'paid'`
    paidWithAmount: number

    @db.agg.sum "amount", `status = 'paid'`
    paidTotal: number

    @db.agg.avg "amount", `status = 'paid'`
    paidAvg?: number

    @db.agg.min "amount", `status = 'paid'`
    paidMin?: number

    @db.agg.countDistinct "customerId"
    buyers: number

    @db.agg.countDistinct "customerId", `status = 'paid'`
    paidBuyers: number

    @db.agg.count '*', `AdCustomer.vip = true`
    vipOrders: number
}

@db.view 'ad_busy_cities'
@db.view.for AdOrder
@db.view.having `buyers > 1 and paidOrders > 0`
export interface AdBusyCities {
    city: AdOrder.city

    @db.agg.countDistinct "customerId"
    buyers: number

    @db.agg.count '*', `status = 'paid'`
    paidOrders: number
}
