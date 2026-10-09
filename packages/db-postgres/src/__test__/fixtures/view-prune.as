// View read pruning (since 0.1.153): LEFT joins a read does not need are
// dropped. The same fixture is shared by db-mysql / db-postgres / db-mongo.

@db.table 'vp_regions'
export interface VpRegion {
    @meta.id
    id: number
    name: string
    taxRate: number
}

@db.table 'vp_customers'
export interface VpCustomer {
    @meta.id
    id: number
    name: string
    regionId?: number
}

@db.table 'vp_products'
export interface VpProduct {
    @meta.id
    id: number
    @db.index.unique 'sku_market'
    sku: string
    @db.index.unique 'sku_market'
    market: string
    title: string
}

// `code` is NOT unique — a join on it may match several rows
@db.table 'vp_statuses'
export interface VpStatus {
    @meta.id
    id: number
    code: string
    label: string
}

@db.table 'vp_notes'
export interface VpNote {
    @meta.id
    id: number
    orderId: number
    at: number
    text: string
}

@db.table 'vp_orders'
export interface VpOrder {
    @meta.id
    id: number
    customerId?: number
    sku?: string
    market?: string
    status: string
    amount: number
    @db.column 'ship_region'
    shipRegionId?: number
}

@db.alias VpRegion
export type VpShipRegion = VpRegion

@db.alias VpNote
export type VpLastNote = VpNote

// Six left joins: PK, chained PK, composite unique, non-unique (never
// dropped), first-row, aliased PK.
@db.view 'vp_order_view'
@db.view.for VpOrder
@db.view.joins VpCustomer, `VpCustomer.id = VpOrder.customerId`, 'left'
@db.view.joins VpRegion, `VpRegion.id = VpCustomer.regionId`, 'left'
@db.view.joins VpProduct, `VpProduct.sku = VpOrder.sku and VpProduct.market = VpOrder.market`, 'left'
@db.view.joins VpStatus, `VpStatus.code = VpOrder.status`, 'left'
@db.view.joins VpLastNote, `VpLastNote.orderId = VpOrder.id`, 'left', `at desc`
@db.view.joins VpShipRegion, `VpShipRegion.id = VpOrder.shipRegionId`, 'left'
export interface VpOrderView {
    id: VpOrder.id
    status: VpOrder.status
    amount: VpOrder.amount
    customerName?: VpCustomer.name
    regionName?: VpRegion.name
    regionTax?: VpRegion.taxRate
    productTitle?: VpProduct.title
    statusLabel?: VpStatus.label
    lastNote?: VpLastNote.text
    shipRegion?: VpShipRegion.name

    @db.compute `amount * coalesce(regionTax, 0)`
    tax?: number
}

// An inner join (never dropped), a view filter on a left-joined column (kept),
// a literal pinning one column of a composite unique key (droppable).
@db.view 'vp_eu_view'
@db.view.for VpOrder
@db.view.joins VpCustomer, `VpCustomer.id = VpOrder.customerId`, 'inner'
@db.view.joins VpProduct, `VpProduct.sku = VpOrder.sku and VpProduct.market = 'EU'`, 'left'
@db.view.joins VpShipRegion, `VpShipRegion.id = VpOrder.shipRegionId`, 'left'
@db.view.filter `VpShipRegion.taxRate >= 0`
export interface VpEuView {
    id: VpOrder.id
    amount: VpOrder.amount
    customerName: VpCustomer.name
    euTitle?: VpProduct.title
    shipRegion?: VpShipRegion.name
}

// A join pinning only part of a unique key — never dropped
@db.view 'vp_partial_view'
@db.view.for VpOrder
@db.view.joins VpProduct, `VpProduct.sku = VpOrder.sku`, 'left'
export interface VpPartialView {
    id: VpOrder.id
    title?: VpProduct.title
}
