// A view field over a whole primitive @db.json field reads its typed value —
// not the JSON text — and sorts / filters by it (since 0.1.162).

@db.table 'vjr_items'
export interface VjrItem {
    @meta.id
    id: number

    @db.json
    score?: number

    @db.json
    label?: string

    @db.json
    active?: boolean
}

@db.view 'vjr_item_view'
@db.view.for VjrItem
export interface VjrItemView {
    id: VjrItem.id
    score?: VjrItem.score
    label?: VjrItem.label
    active?: VjrItem.active
}
