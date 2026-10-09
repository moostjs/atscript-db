// Deterministic paging tie-breaker (since 0.1.153): the primary key appended
// to a `$sort` that does not already order rows totally.

@db.table 'tb_items'
export interface TbItem {
    @meta.id
    id: number

    category: string
    amount: number

    // unique over a required field → orders totally
    @db.index.unique 'code_idx'
    code: string

    // unique over an optional field → several NULLs, not a total order
    @db.index.unique 'nick_idx'
    nick?: string

    // composite unique over required fields
    @db.index.unique 'pair_idx'
    region: string

    @db.index.unique 'pair_idx'
    seq: number

    // unique leaf under an optional parent → nullable
    info?: {
        @db.index.unique 'tag_idx'
        tag: string
    }

    @db.column 'renamed_col'
    renamed: string
}

@db.table 'tb_lines'
export interface TbLine {
    @meta.id
    orderId: number

    @meta.id
    lineNo: number

    amount: number
}

// A view without a declared primary key
@db.view 'tb_item_cats'
@db.view.for TbItem
export interface TbItemCats {
    category: TbItem.category
    amount: TbItem.amount
}

// A view declaring its primary key
@db.view 'tb_item_keyed'
@db.view.for TbItem
export interface TbItemKeyed {
    @meta.id
    id: TbItem.id

    category: TbItem.category
    amount: TbItem.amount
}

// A view selecting the source's key without declaring it
@db.view 'tb_item_ref_id'
@db.view.for TbItem
export interface TbItemRefId {
    id: TbItem.id
    category: TbItem.category
}
