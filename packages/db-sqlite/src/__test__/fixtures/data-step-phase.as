// Before/after pair for `beforeConstraints` data steps: V1 stores duplicate
// codes and dangling owner ids; V2 adds a unique index on `code` and a
// foreign key on `ownerId`, which only land once a data step fixed the rows.

@db.table 'dsp_owners'
export interface DspOwner {
    @meta.id
    id: number

    name: string
}

@db.table 'dsp_items'
export interface DspItemV1 {
    @meta.id
    id: number

    code: string

    ownerId?: number
}

@db.table 'dsp_items'
export interface DspItemV2 {
    @meta.id
    id: number

    @db.index.unique 'dsp_code_idx'
    code: string

    // New column: a `beforeConstraints` step can already write it.
    note?: string

    @db.rel.FK
    ownerId?: DspOwner.id
}

// Rename + new unique index + changed view: a throwing `beforeConstraints`
// step must leave the rename recorded, so a resync can finish the job.
@db.table 'dsr_old'
export interface DsrItemV1 {
    @meta.id
    id: number

    code: string

    kind: string
}

@db.view 'dsr_view'
@db.view.for DsrItemV1
@db.view.filter `DsrItemV1.kind = 'a'`
export interface DsrViewV1 {
    id: DsrItemV1.id
    code: DsrItemV1.code
}

@db.table 'dsr_new'
@db.table.renamed 'dsr_old'
export interface DsrItemV2 {
    @meta.id
    id: number

    @db.index.unique 'dsr_code_idx'
    code: string

    kind: string
}

@db.view 'dsr_view'
@db.view.for DsrItemV2
@db.view.filter `DsrItemV2.kind = 'b'`
export interface DsrViewV2 {
    id: DsrItemV2.id
    code: DsrItemV2.code
}
