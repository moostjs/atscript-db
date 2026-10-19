// `@db.onUpdate.inc` (since 0.1.162): 0 on insert, +1 on every update.
@db.table 'cc_docs'
export interface CcDoc {
    @meta.id
    id: number
    title?: string
    @db.onUpdate.inc
    rev: number.int
}
