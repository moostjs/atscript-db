// Views reading typed leaves inside a @db.json column (view-json.spec.ts,
// since 0.1.136): the declared primitive, or null for a missing path, a JSON
// null or a value of another JSON type.

@db.table 'vj_items'
export interface VjItem {
    @meta.id
    id: number

    label: string

    @db.json
    data?: {
        name?: string
        score?: number
        active?: boolean
        nested?: {
            tag?: string
        }
    }
}

@db.view 'vj_item_view'
@db.view.for VjItem
export interface VjItemView {
    id: VjItem.id
    label: VjItem.label
    name?: VjItem.data.name
    score?: VjItem.data.score
    active?: VjItem.data.active
    tag?: VjItem.data.nested.tag
}

// A JSON leaf as a GROUP BY dimension, an aggregate source and a HAVING operand
@db.view 'vj_tag_totals'
@db.view.for VjItem
@db.view.having `tag != 'skip' and total > 0`
export interface VjTagTotals {
    tag?: VjItem.data.nested.tag

    @db.agg.sum "data.score"
    total?: VjItem.data.score

    @db.agg.count
    items: number
}
