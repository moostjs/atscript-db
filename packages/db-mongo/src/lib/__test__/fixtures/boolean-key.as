// A boolean part of a composite key (a draft and its active row).

@db.table 'bk_drafts'
@db.mongo.collection
export interface BkDraft {
    @meta.id
    id: string

    @meta.id
    active: boolean

    title: string
}

// A compound unique index with a nullable boolean part.
@db.table 'bk_flags'
@db.mongo.collection
export interface BkFlag {
    @db.index.unique 'code_flag'
    code: string

    @db.index.unique 'code_flag'
    flag: boolean | null

    title: string
}
