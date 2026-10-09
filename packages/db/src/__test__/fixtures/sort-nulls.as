// NULL placement in sorts (since 0.1.153): `$nulls` and `@db.sort.nulls`.

@db.table 'sn_items'
export interface SnItem {
    @meta.id
    id: number

    amount?: number

    @db.sort.nulls 'last'
    closedAt?: number

    name: string

    @db.column 'renamed_col'
    @db.sort.nulls 'first'
    renamed?: string

    // required leaf under an optional parent → nullable
    info?: {
        tag: string
    }

    // required parent, optional leaf
    extra: {
        note?: string
        code: string
    }
}

@db.view 'sn_item_view'
@db.view.for SnItem
export interface SnItemView {
    @meta.id
    id: SnItem.id

    name: SnItem.name
    amount: SnItem.amount
}
