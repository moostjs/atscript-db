// Bounded `updateMany` / `deleteMany`, `@db.onUpdate.inc` and the validated
// `updateMany` / `replaceMany` payloads (since 0.1.162).

@db.table 'bw_tasks'
export interface BwTask {
    @meta.id
    id: number.int

    status: string

    @expect.min 0
    priority: number.int

    @meta.required
    title: string

    note?: string

    @db.column.version
    version: number.int

    @db.column.version.exempt
    score?: number

    @db.onUpdate.inc
    rev: number.int

    updatedAt: number.timestamp.updated
}

@db.table 'bw_owners'
export interface BwOwner {
    @meta.id
    id: number.int

    name: string

    @db.rel.from
    items?: BwItem[]
}

@db.table 'bw_items'
export interface BwItem {
    @meta.id
    id: number.int

    label: string

    @db.rel.FK
    @db.rel.onDelete 'cascade'
    ownerId?: BwOwner.id
}

// No primary key: a bounded write cannot order or pin its rows.
@db.table 'bw_logs'
export interface BwLog {
    line: string
}
