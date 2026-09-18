// Fixture for write-transactions.spec.ts: a versioned table with one static
// default, driven through a real AtscriptDbTable over the core MockAdapter.
@db.table 'guarded_items'
export interface GuardedItem {
    @meta.id
    @db.default.increment
    id: number

    name: string

    @db.default 'todo'
    status: 'todo' | 'done'

    @db.column.version
    version: number.int
}
