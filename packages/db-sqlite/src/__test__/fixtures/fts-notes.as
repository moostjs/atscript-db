@db.table 'notes'
export interface Note {
    @meta.id
    @db.default.increment
    id: number

    @db.index.fulltext 'notes_title_ft'
    title: string

    @db.index.fulltext 'notes_body_ft'
    body: string

    category: string
}
