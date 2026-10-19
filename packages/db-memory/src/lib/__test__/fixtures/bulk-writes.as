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

// Composite `@db.column`-renamed key, a self-referencing relation and NULL
// sort keys: a bounded write picks exactly the rows an equal read picks.
@db.table 'bw_boards'
export interface BwBoard {
    @meta.id
    @db.column 'board_org'
    org: string

    @meta.id
    code: string

    title: string

    rank?: number.int

    @db.sort.nulls 'last'
    @db.column 'rank_last'
    rankLast?: number.int

    @db.rel.FK 'parentBoard'
    @db.column 'parent_org'
    parentOrg?: BwBoard.org

    @db.rel.FK 'parentBoard'
    parentCode?: BwBoard.code

    @db.rel.to 'parentBoard'
    @db.rel.filterable
    parentBoard?: BwBoard

    @db.onUpdate.inc
    @db.column 'rev_n'
    rev: number.int
}
