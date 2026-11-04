// Inserted ids of composite primary keys (composite-insert-id.spec.ts). Since 0.1.169.

@db.table 'cid_pairs'
export interface CidPair {
    @meta.id
    left: number

    @meta.id
    @db.column 'right_key'
    right: string

    @db.index.unique 'cid_code_idx'
    code?: number

    label: string
}

@db.table 'cid_single'
export interface CidSingle {
    @meta.id
    @db.default.increment
    id: number

    label: string
}

@db.table 'cid_seq'
export interface CidSeq {
    @meta.id
    tenant: string

    @meta.id
    @db.default.increment
    seq: number

    label: string
}
