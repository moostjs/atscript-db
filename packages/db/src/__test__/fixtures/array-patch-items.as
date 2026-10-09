@db.table 'ap_orders'
export interface ApOrder {
    @meta.id
    id: number

    title: string

    items?: {
        @expect.array.key
        sku: string
        qty: number
        note?: string
        @meta.required
        label?: string
        loc?: db.geoPoint
    }[]

    @db.patch.strategy 'merge'
    mergedItems?: {
        @expect.array.key
        sku: string
        qty: number
        note?: string
    }[]

    @expect.minLength 2
    tags?: string[]
}
