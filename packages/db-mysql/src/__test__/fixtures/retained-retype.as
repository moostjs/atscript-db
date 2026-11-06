// A removed table kept by safe mode whose foreign key references a column
// that changes type (retained-retype.live.spec.ts).

@db.table 'rr_parents'
export interface RrParent {
    @meta.id
    id: number

    @db.index.unique 'rr_code_idx'
    code: string
}

@db.table 'rr_children'
export interface RrChild {
    @meta.id
    id: number

    @db.rel.FK
    parentCode?: RrParent.code
}

// The parent, its `code` now a number (rr_children removed from the schema)
@db.table 'rr_parents'
export interface RrParentV2 {
    @meta.id
    id: number

    @db.index.unique 'rr_code_idx'
    code: number
}
