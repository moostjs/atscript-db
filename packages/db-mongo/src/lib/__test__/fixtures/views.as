// MongoDB view pipelines (since 0.1.136): simple vs pipeline $lookup, inner vs
// left joins, chained joins, physical (@db.column) document paths.

@db.table 'mv_customers'
export interface MvCustomer {
    @meta.id
    id: number

    @db.column 'full_name'
    name: string

    profile: {
        city: string
    }

    score: number
    regionId?: number
    code?: string
}

@db.table 'mv_regions'
export interface MvRegion {
    @meta.id
    id: number

    name: string
    minScore: number
    countryId?: number
    code?: string
}

@db.table 'mv_countries'
export interface MvCountry {
    @meta.id
    id: number

    name: string
}

@db.table 'mv_orders'
export interface MvOrder {
    @meta.id
    id: number

    customerId?: number
    amount: number
    status: string
}

@db.view 'mv_orders_left'
@db.view.for MvOrder
@db.view.joins MvCustomer, `MvCustomer.id = MvOrder.customerId`, 'left'
@db.view.filter `MvOrder.status != 'void'`
export interface MvOrdersLeft {
    id: MvOrder.id
    customerName?: MvCustomer.name
    city?: MvCustomer.profile.city
}

@db.view 'mv_orders_inner'
@db.view.for MvOrder
@db.view.joins MvCustomer, `MvCustomer.id = MvOrder.customerId`
export interface MvOrdersInner {
    id: MvOrder.id
    customerName: MvCustomer.name
}

// Optional join key on both sides — needs the pipeline form (null never matches)
@db.view 'mv_customer_by_code'
@db.view.for MvCustomer
@db.view.joins MvRegion, `MvRegion.code = MvCustomer.code`
export interface MvCustomerByCode {
    id: MvCustomer.id
    regionName: MvRegion.name
}

// Compound condition with a non-equality
@db.view 'mv_customer_eligible'
@db.view.for MvCustomer
@db.view.joins MvRegion, `MvRegion.id = MvCustomer.regionId and MvRegion.minScore <= MvCustomer.score`, 'left'
export interface MvCustomerEligible {
    id: MvCustomer.id
    regionName?: MvRegion.name
}

@db.view 'mv_customer_geo'
@db.view.for MvCustomer
@db.view.joins MvRegion, `MvRegion.id = MvCustomer.regionId`, 'left'
@db.view.joins MvCountry, `MvCountry.id = MvRegion.countryId`, 'left'
export interface MvCustomerGeo {
    id: MvCustomer.id
    regionName?: MvRegion.name
    countryName?: MvCountry.name
}

@db.view 'mv_customer_orders'
@db.view.for MvCustomer
@db.view.joins MvOrder, `MvOrder.customerId = MvCustomer.id and MvOrder.status in ('paid', 'shipped')`, 'left'
@db.view.having `customers > 0`
export interface MvCustomerOrders {
    city: MvCustomer.profile.city

    @db.agg.count "id"
    orders: MvOrder.id

    @db.agg.sum "amount"
    total?: MvOrder.amount

    @db.agg.count
    customers: number
}

// View filter through the shared query translation: `exists` = holds a value,
// `not exists` survives, a field-to-field comparison becomes $expr, `matches`
// parses /re/flags
@db.view 'mv_filter_ops'
@db.view.for MvCustomer
@db.view.filter `MvCustomer.code exists and MvCustomer.regionId not exists and MvCustomer.score > MvCustomer.regionId and MvCustomer.name matches '/^a/i'`
export interface MvFilterOps {
    id: MvCustomer.id
}

// A `@db.column` on a nested leaf renames nothing on documents — the view
// reads `address.zip` where it is stored (since 0.1.137). A field-to-field
// filter comparison is null-guarded like SQL (since 0.1.137).
@db.table 'mv_stores'
export interface MvStore {
    @meta.id
    id: number

    address: {
        city: string

        @db.column 'zip_code'
        zip?: string
    }

    qty: number
    cap?: number
}

@db.view 'mv_store_zips'
@db.view.for MvStore
@db.view.filter `MvStore.address.zip exists and MvStore.qty > MvStore.cap`
export interface MvStoreZips {
    id: MvStore.id
    zip?: MvStore.address.zip
}

@db.view 'mv_zip_stats'
@db.view.for MvStore
export interface MvZipStats {
    city: MvStore.address.city

    @db.agg.countDistinct "address.zip"
    zips: number
}
