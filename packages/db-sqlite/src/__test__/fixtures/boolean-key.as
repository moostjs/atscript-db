// A composite primary key with a boolean part (a draft and its active row).

@db.table 'bk_drafts'
export interface BkDraft {
    @meta.id
    id: string

    @meta.id
    active: boolean

    title: string
}

@db.table 'bk_revisions'
export interface BkRevision {
    @meta.id
    id: string

    @meta.id
    rev: number

    title: string
}
