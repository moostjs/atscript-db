// Conditional aggregates + countDistinct in views (view-mappings.spec.ts). Since 0.1.136.

@db.table 'vg_orders'
export interface VgOrder {
    @meta.id
    id: number

    customerId: number

    status: string

    @db.column 'amount_cents'
    amount: number

    regionId?: number
}

@db.table 'vg_regions'
export interface VgRegion {
    @meta.id
    id: number

    name: string

    active: boolean
}

@db.view 'vg_stats'
@db.view.for VgOrder
@db.view.joins VgRegion, `VgRegion.id = VgOrder.regionId`
export interface VgStats {
    region: VgRegion.name

    @db.agg.count
    orders: number

    @db.agg.count '*', `VgOrder.status = 'paid'`
    paidOrders: number

    @db.agg.sum "amount", `status = 'paid' and VgRegion.active = true`
    paidTotal: number

    @db.agg.countDistinct "customerId"
    buyers: number

    @db.agg.countDistinct "customerId", `VgOrder.amount >= 100`
    bigBuyers: number

    @db.agg.avg "amount", `VgOrder.status = 'paid'`
    paidAvg?: number
}
