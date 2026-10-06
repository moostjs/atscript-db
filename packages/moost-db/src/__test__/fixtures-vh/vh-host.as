import { VhDict } from './vh-dict'

@db.table 'vh_items'
export interface VhItem {
    @meta.id
    id: number

    @vhx.bind VhDict, 'value'
    color: string

    size: string
}

@db.view 'vh_items_view'
@db.view.for VhItem
export interface VhItemView {
    id: VhItem.id
    color: VhItem.color
}

export interface VhForm {
    @vhx.bind VhDict, 'value'
    shade: string
}

// Inherited through `extends`.
export interface VhExtended extends VhForm {
    note?: string
}

// A view that carries its OWN binding on a column (the host is the `@db.view`).
@db.view 'vh_items_bound_view'
@db.view.for VhItem
export interface VhItemBoundView {
    id: VhItem.id

    @vhx.bind VhDict, 'value'
    tint: VhItem.size
}
