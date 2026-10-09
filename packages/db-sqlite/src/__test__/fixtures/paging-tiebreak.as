// Deterministic paging tie-breaker (since 0.1.153): rows that tie on every
// `$sort` key come back in primary-key order, in the direction of the last
// `$sort` key — the same order on every read.

@db.table 'pt_rows'
export interface PtRow {
    @meta.id
    id: number

    grp: number
    label: string

    @db.index.unique 'pt_code'
    code: string
}

@db.table 'pt_pairs'
export interface PtPair {
    @meta.id
    a: number

    @meta.id
    b: number

    grp: number
}
