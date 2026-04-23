// Fixture for the @db.table.filterable 'manual' / @db.table.sortable 'manual'
// gate tests. Covers the three shapes:
//   - default (no gating annotations) — all fields are implicitly open
//   - filter-manual — only @db.column.filterable fields allowed in filters
//   - sort-manual — only @db.column.sortable fields allowed in sort

@db.table 'default_gate'
export interface DefaultGate {
    @meta.id
    id: string

    email: string

    name: string
}

@db.table 'filter_manual'
@db.table.filterable 'manual'
export interface FilterManual {
    @meta.id
    id: string

    @db.column.filterable
    email: string

    name: string
}

@db.table 'sort_manual'
@db.table.sortable 'manual'
export interface SortManual {
    @meta.id
    id: string

    @db.column.sortable
    createdAt: number.timestamp

    email: string
}
