// Plain value-help dictionary interface — NOT a @db.table.
// Models a static lookup source served by a non-DB controller
// (e.g. AsJsonValueHelpController). Used below to verify that
// @db.rel.FK validates when the target is a plain (non-table)
// interface whose PK field carries @meta.id.

export interface StatusDict {
    @meta.id
    id: string

    label: string
}
