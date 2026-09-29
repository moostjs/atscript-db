@db.table 'renamed_versions'
export interface RenamedVersionDoc {
    @meta.id
    id: number

    name: string

    counter: number

    @db.column 'row_version'
    @db.column.version
    version: number.int
}

@db.table 'renamed_revisions'
export interface RenamedRevisionDoc {
    @meta.id
    id: number

    name: string

    @db.column 'rev'
    @db.column.version
    revision: number.int
}
