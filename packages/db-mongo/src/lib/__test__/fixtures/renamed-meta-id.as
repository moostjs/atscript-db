// Fixture for renamed-meta-id-server.spec.ts — a non-`_id` `@meta.id` renamed
// with `@db.column`: its managed unique index must be built on the stored key.

@db.table 'renamed_pk_tags'
export interface RenamedPkTag {
    @meta.id
    @db.column 'tag_code'
    code: string

    title: string
}
