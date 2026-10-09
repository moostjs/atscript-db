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
    }[]
}
