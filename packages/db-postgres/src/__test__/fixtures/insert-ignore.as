// Conflict-ignoring insert (insert-ignore.spec.ts). Since 0.1.148.

@db.table 'ig_items'
export interface IgItem {
    @meta.id
    id: number

    @db.index.unique 'sku_idx'
    sku: string

    @db.index.unique 'pair_idx'
    pairA?: string

    @db.index.unique 'pair_idx'
    pairB?: string

    qty: number
}

@db.table 'ig_auto'
export interface IgAuto {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'auto_sku_idx'
    sku: string

    label: string
}

@db.table 'ig_notes'
export interface IgNote {
    @meta.id
    id: number

    @db.rel.FK
    itemId: IgItem.id

    @db.rel.to
    item?: IgItem

    text: string
}

@db.table 'ig_prices'
export interface IgPrice {
    @meta.id
    @db.default.increment
    id: number

    @db.index.unique 'price_idx'
    @db.column.precision 10, 2
    price: number
}
