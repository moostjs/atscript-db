// Real SQLite views over flattened / renamed source columns, left and
// chained joins (views.spec.ts, since 0.1.136).

@db.table 'sv_customers'
export interface SvCustomer {
    @meta.id
    id: number

    @db.column 'full_name'
    name: string

    address: {
        city: string

        @db.column 'zip_code'
        zip: string
    }

    regionId?: number
}

@db.table 'sv_regions'
export interface SvRegion {
    @meta.id
    id: number

    @db.column 'region_name'
    name: string

    countryId?: number
}

@db.table 'sv_countries'
export interface SvCountry {
    @meta.id
    id: number

    name: string
}

@db.table 'sv_orders'
export interface SvOrder {
    @meta.id
    id: number

    customerId?: number
    amount: number
    status: string
}

@db.view 'sv_customer_list'
@db.view.for SvCustomer
@db.view.filter `SvCustomer.address.city != 'Nowhere' and SvCustomer.address.zip exists`
export interface SvCustomerList {
    id: SvCustomer.id
    name: SvCustomer.name
    city: SvCustomer.address.city
    address: SvCustomer.address
}

@db.view 'sv_orders_left'
@db.view.for SvOrder
@db.view.joins SvCustomer, `SvCustomer.id = SvOrder.customerId`, 'left'
export interface SvOrdersLeft {
    id: SvOrder.id
    customerName?: SvCustomer.name
    customerCity?: SvCustomer.address.city
}

@db.view 'sv_orders_inner'
@db.view.for SvOrder
@db.view.joins SvCustomer, `SvCustomer.id = SvOrder.customerId`
export interface SvOrdersInner {
    id: SvOrder.id
    customerName: SvCustomer.name
}

// A filter on the left-joined side drops the unmatched rows (acts inner)
@db.view 'sv_orders_left_paris'
@db.view.for SvOrder
@db.view.joins SvCustomer, `SvCustomer.id = SvOrder.customerId`, 'left'
@db.view.filter `SvCustomer.address.city = 'Paris'`
export interface SvOrdersLeftParis {
    id: SvOrder.id
    customerName?: SvCustomer.name
}

@db.view 'sv_customer_geo'
@db.view.for SvCustomer
@db.view.joins SvRegion, `SvRegion.id = SvCustomer.regionId`, 'left'
@db.view.joins SvCountry, `SvCountry.id = SvRegion.countryId`, 'left'
export interface SvCustomerGeo {
    id: SvCustomer.id
    name: SvCustomer.name
    regionName?: SvRegion.name
    countryName?: SvCountry.name
}

@db.view 'sv_city_totals'
@db.view.for SvCustomer
@db.view.joins SvOrder, `SvOrder.customerId = SvCustomer.id and SvOrder.status in ('paid', 'shipped')`, 'left'
@db.view.having `customers > 0`
export interface SvCityTotals {
    city: SvCustomer.address.city

    @db.agg.count "id"
    orders: SvOrder.id

    @db.agg.sum "amount"
    total?: SvOrder.amount

    @db.agg.count
    customers: number
}
