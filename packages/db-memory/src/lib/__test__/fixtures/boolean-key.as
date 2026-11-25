// A composite primary key with a boolean part (a draft and its active row).

@db.table 'bk_drafts'
export interface BkDraft {
    @meta.id
    id: string

    @meta.id
    active: boolean

    title: string
}

// A compound unique index with a nullable boolean part.
@db.table 'bk_flags'
export interface BkFlag {
    @meta.id
    id: string

    @db.index.unique 'code_flag'
    code: string

    @db.index.unique 'code_flag'
    flag: boolean | null

    title: string
}
