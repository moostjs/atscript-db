// Fixtures for insert-representation.spec.ts (since 0.1.168).

@db.table 'irep_notes'
export interface IrepNote {
    @meta.id
    id: number

    title: string

    @db.default 'draft'
    status: string

    secret?: string

    tenant: string
}

// Composite primary key with a scalar unique column (since 0.1.169): the
// read-back addresses the row by its key object, as `GET /one?k=v` does.
@db.table 'irep_pairs'
export interface IrepPair {
    @meta.id
    left: number

    @meta.id
    right: string

    @db.index.unique 'irep_pair_code_idx'
    code?: number

    label: string
}
