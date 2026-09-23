// Fixture for document-field-mapper-renames.spec.ts — `@db.column` renames a
// document adapter must apply on every field-path position: a top-level
// scalar and a top-level object whose nested keys are stored as-is.

@db.table 'doc_renames'
export interface DocRename {
    @meta.id
    id: number

    title: string

    @db.column 'opened_on'
    renamedAt?: number.timestamp

    @db.column 'prof'
    profile?: {
        bio?: string
    }
}
