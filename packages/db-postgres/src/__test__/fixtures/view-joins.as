// A view over flattened / renamed source columns with a left and a chained
// join — the DDL must name PHYSICAL columns (since 0.1.136).

@db.table 'vj_customers'
export interface VjCustomer {
    @meta.id
    id: number

    @db.column 'full_name'
    name: string

    address: {
        @db.column 'zip_code'
        zip: string
    }

    regionId?: number
}

@db.table 'vj_regions'
export interface VjRegion {
    @meta.id
    id: number
    name: string
}

@db.table 'vj_orders'
export interface VjOrder {
    @meta.id
    id: number
    customerId?: number
}

@db.view 'vj_order_list'
@db.view.for VjOrder
@db.view.joins VjCustomer, `VjCustomer.id = VjOrder.customerId`, 'left'
@db.view.joins VjRegion, `VjRegion.id = VjCustomer.regionId`, 'left'
export interface VjOrderList {
    id: VjOrder.id
    customerName?: VjCustomer.name
    zip?: VjCustomer.address.zip
    regionName?: VjRegion.name
}
