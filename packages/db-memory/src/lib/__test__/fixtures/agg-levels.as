// countDistinct over a field list, conditional aggregates ($where) and
// two-level aggregates ($from) — aggregate-levels.spec.ts. The same fixture,
// data and expectations run on every adapter. Since 0.1.168.

@db.table 'al_sales'
export interface AlSale {
    @meta.id
    id: number

    region: string

    customerId?: number

    productId?: number

    status: string

    @db.column 'amount_cents'
    amount?: number

    qty: number

    createdAt: number.timestamp

    paid: boolean

    shipping: {
        city?: string
    }

    tags?: string[]
}
