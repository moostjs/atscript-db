// Exercise @db.table.filterable 'manual' + @db.column.filterable /
// @db.column.sortable annotations. The compile must accept them
// on a @db.table host and reject them on non-table hosts (the
// negative side is covered by an .as file that would fail to
// compile — we don't include one here; the positive path is what
// the spec asserts).

@db.table 'users'
@db.table.filterable 'manual'
@db.table.sortable 'manual'
export interface GatedUser {
    @meta.id
    @db.default.increment
    id: number

    @db.column.filterable
    @db.column.sortable
    email: string

    // Intentionally un-annotated — would be rejected under manual gate.
    name: string
}
