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

// Nested writes: a related table's own fields, a JSON object, a union of objects.
@db.table 'upd_owners'
export interface UpdOwner {
    @meta.id
    id: number
    name: string
    updatedAt: number.timestamp.updated
}

export interface UpdCard {
    kind: 'card'
    at: number.timestamp.updated
}

export interface UpdBank {
    kind: 'bank'
    at: number.timestamp.updated
}

@db.table 'upd_orders'
@db.depth.limit 1
export interface UpdOrder {
    @meta.id
    id: number
    title?: string
    updatedAt: number.timestamp.updated

    @db.json
    blob: {
        note?: string
        at: number.timestamp.updated
    }

    payment?: UpdCard | UpdBank

    @db.rel.FK
    ownerId?: UpdOwner.id

    @db.rel.to
    owner?: UpdOwner
}
