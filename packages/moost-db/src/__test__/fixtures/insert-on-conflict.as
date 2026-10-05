// Fixtures for insert-on-conflict.spec.ts (since 0.1.148).

@db.table 'ioc_items'
export interface IocItem {
    @meta.id
    id: number

    @db.index.unique 'ioc_sku_idx'
    sku: string

    qty: number
}
