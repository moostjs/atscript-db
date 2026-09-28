// Fixture for document-field-mapper-renames.spec.ts — `@db.column` renames a
// document adapter must apply on every field-path position: a top-level
// scalar and a top-level object whose nested keys are stored as-is. A
// `@db.column` on a nested leaf (`address.zip`) renames nothing on documents
// — the leaf is stored at its logical path — while a relational layout
// still flattens it to `address__zip_code`.

@db.table 'doc_renames'
export interface DocRename {
    @meta.id
    id: number

    title: string

    @db.column 'opened_on'
    renamedAt?: number.timestamp

    @db.column 'prof'
    @db.patch.strategy 'merge'
    profile?: {
        @db.index.plain 'bio_idx'
        bio?: string
    }

    address?: {
        city?: string

        @db.column 'zip_code'
        @db.column.renamed 'postcode'
        @db.index.plain 'zip_idx'
        zip?: string
    }

    @db.column 'cnt'
    visits?: number
}
