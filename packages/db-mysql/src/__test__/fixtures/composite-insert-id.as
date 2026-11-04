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
@db.depth.limit 2
export interface CidSeq {
    @meta.id
    tenant: string

    @meta.id
    @db.default.increment
    seq: number

    label: string

    @db.rel.from 'seq'
    kids?: CidSeqKid[]
}

@db.table 'cid_seq_kids'
export interface CidSeqKid {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK 'seq'
    seqTenant?: CidSeq.tenant

    @db.rel.FK 'seq'
    seqSeq?: CidSeq.seq

    note: string
}

// A DATETIME key part: the id reports it as epoch ms, the form reads answer.
@db.table 'cid_stamps'
export interface CidStamp {
    @meta.id
    tenant: string

    @meta.id
    @db.mysql.type "DATETIME(3)"
    at: number

    label: string
}

// A single DATETIME primary key: reported as epoch ms, like the composite parts.
@db.table 'cid_stamp_single'
export interface CidStampSingle {
    @meta.id
    @db.mysql.type "DATETIME(3)"
    at: number

    label: string
}
