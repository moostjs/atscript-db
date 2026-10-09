// NULL placement in sort (`$nulls`, since 0.1.153): optional fields holding
// a value, an explicit null and no key at all; a `@db.sort.nulls` default; a
// `@db.column`-renamed key; a nested optional key; a `$with` relation.

@db.table 'ns_rows'
export interface NsRow {
    @meta.id
    id: number

    grp: string

    @db.column 'amt'
    amount?: number

    @db.sort.nulls 'last'
    closedAt?: number

    @db.index.fulltext 'ns_rows_ft'
    name: string

    info?: {
        score?: number
    }

    @db.rel.from
    items?: NsItem[]
}

@db.table 'ns_items'
export interface NsItem {
    @meta.id
    id: number

    @db.rel.FK
    rowId: NsRow.id

    @db.column 'item_rank'
    rank?: number

    @db.rel.to
    row?: NsRow
}
