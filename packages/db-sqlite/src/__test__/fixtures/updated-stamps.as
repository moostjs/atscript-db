// `number.timestamp.updated` (atscript 0.1.106) carries `@db.default.now` and
// `@db.onUpdate.now`: filled on insert, set to the current time on every update.
export type Stamp = number.timestamp.updated

@db.table 'upd_docs'
export interface UpdDoc {
    @meta.id
    id: number
    title?: string
    updatedAt: number.timestamp.updated
    aliased: Stamp
    nullable: number.timestamp.updated | null
    audit: {
        note?: string
        at: number.timestamp.updated
    }
}

// The same table in the layout atscript-db <= 0.1.155 created for it (a plain
// number column, no default), then after the upgrade.
@db.table 'upd_upgrade'
export interface UpdBefore {
    @meta.id
    id: number
    title?: string
    updatedAt: number.timestamp
    maybe: number.timestamp | null
}

@db.table 'upd_upgrade'
export interface UpdAfter {
    @meta.id
    id: number
    title?: string
    updatedAt: number.timestamp.updated
    maybe: number.timestamp.updated | null
}
