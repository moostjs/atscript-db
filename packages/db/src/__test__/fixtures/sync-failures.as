// Fixtures for DDL failures inside one table's step and for errored plan
// entries that issue no DDL (since 0.1.129). Three tables, so a failure on
// the middle one can be shown not to stop the run; `sf_beta` appears in
// several versions so one DbSpace can sync "before" and then "after".

@db.table 'sf_alpha'
export interface SfAlpha {
    @meta.id
    @db.default.increment
    id: number

    name: string

    extra?: string
}

// References sf_alpha
@db.table 'sf_beta'
export interface SfBetaV1 {
    @meta.id
    @db.default.increment
    id: number

    @db.rel.FK
    alphaId: SfAlpha.id
}

// FK dropped and a column added in the same sync
@db.table 'sf_beta'
export interface SfBetaV2 {
    @meta.id
    @db.default.increment
    id: number

    alphaId: number

    note?: string
}

// FK dropped and `alphaId` renamed onto a column that already exists live
// (`ownerId`) → rename conflict → errored plan entry
@db.table 'sf_beta'
export interface SfBetaConflict {
    @meta.id
    @db.default.increment
    id: number

    @db.column.renamed 'alphaId'
    ownerId: number
}

@db.table 'sf_gamma'
export interface SfGamma {
    @meta.id
    @db.default.increment
    id: number

    name: string

    extra?: string
}

// `@db.sync.method 'recreate'` — an adapter without `recreateTable` cannot
// apply a type change on it
@db.table 'sf_gamma'
@db.sync.method 'recreate'
export interface SfGammaRecreate {
    @meta.id
    @db.default.increment
    id: number

    name: string

    extra?: string
}
