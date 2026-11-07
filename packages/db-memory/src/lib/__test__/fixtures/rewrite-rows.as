// `rewriteRowsStep` (since 0.1.175) on the in-memory adapter, which has no
// transactions: the step runs in pass-through mode.

@db.table 'rw_chats'
export interface RwChat {
    @meta.id
    id: number.int

    title: string

    @db.json
    @expect.maxLength 3
    turns: string[]
}
