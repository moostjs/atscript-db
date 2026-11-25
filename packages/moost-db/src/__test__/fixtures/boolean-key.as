// A composite primary key with a boolean part (a draft and its active row).

@db.table 'bk_drafts'
export interface BkDraft {
    @meta.id
    id: string

    @meta.id
    active: boolean

    title: string
}
