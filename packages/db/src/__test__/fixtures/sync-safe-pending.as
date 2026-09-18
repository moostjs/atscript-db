// Fixtures for safe-mode pending work: a nullable → required change on an
// otherwise unchanged table. The same physical name appears in two versions
// so one DbSpace can sync the "before" model and then the "after" model.

@db.table 'sp_notes'
export interface SpNoteV1 {
    @meta.id
    @db.default.increment
    id: number

    body?: string
}

// `body` becomes required → nullable change (DDL on adapters that enforce it)
@db.table 'sp_notes'
export interface SpNoteV2 {
    @meta.id
    @db.default.increment
    id: number

    body: string
}
