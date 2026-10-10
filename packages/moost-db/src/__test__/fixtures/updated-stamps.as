// `number.timestamp.updated` (atscript 0.1.106) carries `@db.default.now` and
// `@db.onUpdate.now`: filled on insert, set to the current time on every update.
@db.table 'upd_docs'
export interface UpdDoc {
    @meta.id
    id: number
    title?: string
    updatedAt: number.timestamp.updated
    audit: {
        note?: string
        at: number.timestamp.updated
    }
}
