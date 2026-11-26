// Integer key columns and their value ranges (key-ranges.spec.ts).

@db.table 'kr_smalls'
export interface KrSmall {
    @meta.id
    id: number.int.int16

    label: string
}

@db.table 'kr_ints'
export interface KrInt {
    @meta.id
    id: number.int

    @db.index.unique
    code: number.int | null

    @db.index.fulltext 'kr_label'
    label: string
}

@db.table 'kr_seqs'
export interface KrSeq {
    @meta.id
    @db.default.increment
    id: number.int

    label: string
}

@db.table 'kr_items'
export interface KrItem {
    @meta.id
    @db.rel.FK
    ownerId: KrInt.id

    @meta.id
    n: number.int.int16

    label: string
}

@db.table 'kr_plains'
export interface KrPlain {
    @meta.id
    id: number

    @db.index.unique
    @db.pg.type 'NUMERIC(20,0)'
    code?: number

    @db.pg.type 'int2'
    small?: number

    ref: string

    label: string
}

@db.view.for KrSeq
export interface KrSeqView {
    @meta.id
    id: KrSeq.id

    label: KrSeq.label
}
