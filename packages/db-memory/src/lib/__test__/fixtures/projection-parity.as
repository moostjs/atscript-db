// Projection parity fixtures (since 0.1.145) — mirrored in db-memory and
// db-sqlite (`projection-parity.spec.ts`): an inclusion `$select` returns
// exactly the selected fields on every adapter; the primary key is never
// added implicitly.

@db.table 'parity_coded'
@db.table.preferredId.uniqueIndex 'code_idx'
export interface ParityCoded {
    @meta.id
    id: number

    @db.index.unique 'code_idx'
    code: string

    owner: string

    note?: string
}

@db.table 'parity_lines'
export interface ParityLine {
    @meta.id
    orderId: number

    @meta.id
    lineNo: number

    owner: string
}
