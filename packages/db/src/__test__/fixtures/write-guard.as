// Fixture for write-guard.spec.ts: a versioned table with one static default
// and one optional column, so a guard sees defaults applied, `$cas` stripped
// and `undefined` props pruned.
@db.table 'guarded_rows'
export interface GuardedRow {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.default 'todo'
    status: 'todo' | 'done'

    note?: string

    @db.column.version
    version: number.int
}
